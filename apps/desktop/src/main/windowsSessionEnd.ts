/**
 * Process-local coordination for Windows shutdown, restart, and logoff.
 * Query events are reversible, so terminal-sensitive active-session events are
 * held until WM_ENDSESSION reports whether Windows confirmed or cancelled the
 * request. The confirmed flag remains monotonic for the rest of the process
 * lifetime.
 */
import type {
  AgentEvent,
  AgentKind,
  SessionEventDispatchGate,
  SessionEventReplayFactory,
} from '@cindy/maker-core';

import { createLogger } from './logger.js';

const log = createLogger('windows-session-end');

let windowsSessionEnding = false;
const interruptedSessionIds = new Set<string>();
let pendingQuerySessionTurnGenerations: Map<string, Set<number>> | null = null;
const pendingSilentStopContinuationGenerations = new Map<string, number>();
const deferredTerminalTurnGenerations = new Map<string, Set<number>>();
const confirmedTerminalTurnGenerations = new Map<string, Set<number>>();
let confirmedRecoveryMarkerState: 'idle' | 'pending' | 'durable' | 'fallback' = 'idle';
let pendingEventCallbacks: Array<{ replay: () => void; discard?: () => void }> = [];

export interface WindowsSessionEndActiveTurn {
  sessionId: string;
  turnGeneration: number;
}

function addQueryTurn(sessionId: string, turnGeneration: number): boolean {
  if (!pendingQuerySessionTurnGenerations) return false;
  const generations = pendingQuerySessionTurnGenerations.get(sessionId) ?? new Set<number>();
  const previousSize = generations.size;
  generations.add(turnGeneration);
  pendingQuerySessionTurnGenerations.set(sessionId, generations);
  return generations.size !== previousSize;
}

function deleteQueryTurn(sessionId: string, turnGeneration: number): void {
  const generations = pendingQuerySessionTurnGenerations?.get(sessionId);
  if (!generations) return;
  generations.delete(turnGeneration);
  if (generations.size === 0) pendingQuerySessionTurnGenerations?.delete(sessionId);
}

function isProtectedQueryTurn(sessionId: string, event: AgentEvent): boolean {
  return (
    typeof event.sessionTurnGeneration === 'number' &&
    pendingQuerySessionTurnGenerations?.get(sessionId)?.has(event.sessionTurnGeneration) === true
  );
}

function addDeferredTerminalTurn(sessionId: string, turnGeneration: number): void {
  const generations = deferredTerminalTurnGenerations.get(sessionId) ?? new Set<number>();
  generations.add(turnGeneration);
  deferredTerminalTurnGenerations.set(sessionId, generations);
}

function hasDeferredTerminalTurn(sessionId: string, turnGeneration: number): boolean {
  return deferredTerminalTurnGenerations.get(sessionId)?.has(turnGeneration) === true;
}

function addConfirmedTerminalTurn(sessionId: string, turnGeneration: number): void {
  const generations = confirmedTerminalTurnGenerations.get(sessionId) ?? new Set<number>();
  generations.add(turnGeneration);
  confirmedTerminalTurnGenerations.set(sessionId, generations);
}

function hasConfirmedTerminalTurn(sessionId: string, event: AgentEvent): boolean {
  return (
    typeof event.sessionTurnGeneration === 'number' &&
    confirmedTerminalTurnGenerations.get(sessionId)?.has(event.sessionTurnGeneration) === true
  );
}

function finishConfirmedTerminalTurn(sessionId: string, event: AgentEvent): void {
  if (event.type !== 'done' || typeof event.sessionTurnGeneration !== 'number') return;
  const generations = confirmedTerminalTurnGenerations.get(sessionId);
  if (!generations) return;
  generations.delete(event.sessionTurnGeneration);
  if (generations.size === 0) confirmedTerminalTurnGenerations.delete(sessionId);
}

function holdConfirmedEvent(getReplay: SessionEventReplayFactory): void {
  if (confirmedRecoveryMarkerState !== 'pending') return;
  const replay = getReplay();
  pendingEventCallbacks.push({ replay, discard: replay.discard });
}

function isTerminalAgentErrorEvent(event: AgentEvent): boolean {
  if (event.type !== 'error') return false;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return true;
  const data = event.data as { isTerminal?: unknown; willRetry?: unknown };
  if (typeof data.isTerminal === 'boolean') return data.isTerminal;
  if (typeof data.willRetry === 'boolean') return !data.willRetry;
  return true;
}

function isSilentStopDoneEvent(event: AgentEvent): boolean {
  if (event.type !== 'done') return false;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return false;
  return (event.data as { silentStop?: unknown }).silentStop === true;
}

function isTerminalStatusEvent(event: AgentEvent): boolean {
  if (event.type !== 'status') return false;
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return false;
  return (event.data as { isRunning?: unknown }).isRunning === false;
}

function replayPendingQueryEvents(): void {
  pendingQuerySessionTurnGenerations = null;
  pendingSilentStopContinuationGenerations.clear();
  deferredTerminalTurnGenerations.clear();
  const callbacks = pendingEventCallbacks;
  pendingEventCallbacks = [];
  for (const { replay } of callbacks) {
    try {
      replay();
    } catch (error) {
      // Original session listeners isolate their own failures. Timeout replay
      // runs outside that emitter, so preserve the same containment here.
      log.warn('query-phase event replay failed', error);
    }
  }
}

export function beginWindowsSessionEndQuery(
  activeTurns: Iterable<WindowsSessionEndActiveTurn>,
): void {
  if (windowsSessionEnding) return;
  if (pendingQuerySessionTurnGenerations) {
    // Repeated advisory messages describe the same currently active turns.
    // Ensure membership without double-counting an existing generation.
    for (const { sessionId, turnGeneration } of activeTurns) {
      addQueryTurn(sessionId, turnGeneration);
    }
    return;
  }
  pendingQuerySessionTurnGenerations = new Map();
  for (const { sessionId, turnGeneration } of activeTurns) {
    addQueryTurn(sessionId, turnGeneration);
  }
}

/** Keep turns dispatched during the advisory query inside the protected snapshot. */
export function noteWindowsSessionEndTurnStarted(
  sessionId: string,
  agentKind: AgentKind,
  turnGeneration: number,
): boolean {
  if (windowsSessionEnding || agentKind !== 'claude-code' || !pendingQuerySessionTurnGenerations) {
    return false;
  }
  // The replacement request after silent-stop is the same product turn. Its
  // eventual normal done owns the transferred generation, while a failed
  // dispatch is settled by finishWindowsSessionEndProductTurn().
  const replacedGeneration = pendingSilentStopContinuationGenerations.get(sessionId);
  if (replacedGeneration !== undefined) {
    deleteQueryTurn(sessionId, replacedGeneration);
    addQueryTurn(sessionId, turnGeneration);
    pendingSilentStopContinuationGenerations.set(sessionId, turnGeneration);
    return false;
  }
  return addQueryTurn(sessionId, turnGeneration);
}

/** Roll back a query-time turn reservation that never reached its provider. */
export function rollbackWindowsSessionEndTurnStarted(
  sessionId: string,
  turnGeneration: number,
): void {
  finishWindowsSessionEndProductTurn(sessionId, turnGeneration);
}

/** Retire one completed Claude product turn from the advisory snapshot. */
export function finishWindowsSessionEndProductTurn(
  sessionId: string,
  turnGeneration = pendingSilentStopContinuationGenerations.get(sessionId),
): void {
  if (windowsSessionEnding || !pendingQuerySessionTurnGenerations || turnGeneration === undefined) {
    return;
  }
  deleteQueryTurn(sessionId, turnGeneration);
  if (pendingSilentStopContinuationGenerations.get(sessionId) === turnGeneration) {
    pendingSilentStopContinuationGenerations.delete(sessionId);
  }
}

/** WM_ENDSESSION(wParam=FALSE) is the authoritative cancellation signal. */
export function cancelWindowsSessionEndQuery(): void {
  if (windowsSessionEnding || !pendingQuerySessionTurnGenerations) return;
  replayPendingQueryEvents();
}

export function shouldGateWindowsSessionEndEvent(
  sessionId: string,
  agentKind: AgentKind,
  event: AgentEvent,
): boolean {
  if (agentKind !== 'claude-code') return false;
  if (
    windowsSessionEnding &&
    confirmedRecoveryMarkerState !== 'fallback' &&
    interruptedSessionIds.has(sessionId)
  ) {
    if (isTerminalAgentErrorEvent(event)) return true;
    if (
      hasConfirmedTerminalTurn(sessionId, event) &&
      (isTerminalStatusEvent(event) || event.type === 'done')
    ) {
      return true;
    }
  }
  return (
    isProtectedQueryTurn(sessionId, event) &&
    (isTerminalAgentErrorEvent(event) || event.type === 'done')
  );
}

export function gateWindowsSessionEndEvent(
  sessionId: string,
  agentKind: AgentKind,
  event: AgentEvent,
  getReplay: SessionEventReplayFactory,
): boolean {
  if (agentKind !== 'claude-code') return false;
  // Confirmation is irreversible. Keep shutdown-generated terminal failures out
  // of Session's unified fan-out until the protected session is detached; the
  // interrupted marker is the authoritative restart state for these turns.
  if (
    windowsSessionEnding &&
    confirmedRecoveryMarkerState !== 'fallback' &&
    interruptedSessionIds.has(sessionId)
  ) {
    if (isTerminalAgentErrorEvent(event)) {
      if (typeof event.sessionTurnGeneration !== 'number') return false;
      addConfirmedTerminalTurn(sessionId, event.sessionTurnGeneration);
      holdConfirmedEvent(getReplay);
      return true;
    }
    // Claude closes a terminal failure with status:isRunning=false and done.
    // Once its error was suppressed, drop that paired tail at the same unified
    // boundary; a normal done without a preceding shutdown error still passes.
    if (
      hasConfirmedTerminalTurn(sessionId, event) &&
      (isTerminalStatusEvent(event) || event.type === 'done')
    ) {
      holdConfirmedEvent(getReplay);
      finishConfirmedTerminalTurn(sessionId, event);
      return true;
    }
  }
  if (!isProtectedQueryTurn(sessionId, event)) return false;
  const turnGeneration = event.sessionTurnGeneration as number;
  if (isTerminalAgentErrorEvent(event)) {
    addDeferredTerminalTurn(sessionId, turnGeneration);
    const replay = getReplay();
    pendingEventCallbacks.push({ replay, discard: replay.discard });
    return true;
  }
  if (event.type !== 'done') return false;
  if (hasDeferredTerminalTurn(sessionId, turnGeneration)) {
    const replay = getReplay();
    pendingEventCallbacks.push({ replay, discard: replay.discard });
    return true;
  }
  // A claim-bearing or silent-stop done is only an SDK continuation boundary;
  // the product turn remains active, so keep the query-time snapshot protected
  // until an unclaimed terminal done or Windows confirmation arrives.
  if (event.turnContinuationId !== undefined) return false;
  if (isSilentStopDoneEvent(event)) {
    pendingSilentStopContinuationGenerations.set(sessionId, turnGeneration);
    return false;
  }
  // An unclaimed done without a preceding terminal error completed normally
  // during the advisory query. Let consumers commit it and exclude it from
  // interruption.
  finishWindowsSessionEndProductTurn(sessionId, turnGeneration);
  return false;
}

/** Install one sparse gate whose hot-path preflight does not allocate per event. */
export function createWindowsSessionEndEventGate(
  sessionId: string,
  agentKind: AgentKind,
): SessionEventDispatchGate {
  const gate: SessionEventDispatchGate = (event, getReplay) =>
    gateWindowsSessionEndEvent(sessionId, agentKind, event, getReplay);
  gate.shouldRun = (event) => shouldGateWindowsSessionEndEvent(sessionId, agentKind, event);
  return gate;
}

/** Adapter for the already-sparse terminal-only listener gates. */
export function deferWindowsSessionEndEvent(
  sessionId: string,
  agentKind: AgentKind,
  event: AgentEvent,
  replay: () => void,
  discard?: () => void,
): boolean {
  return gateWindowsSessionEndEvent(sessionId, agentKind, event, () =>
    Object.assign(replay, { discard: discard ?? (() => undefined) }),
  );
}

export function markWindowsSessionEnding(activeSessionIds: Iterable<string>): string[] {
  const interruptedAtQueryOrConfirmation = new Set(
    pendingQuerySessionTurnGenerations?.keys() ?? [],
  );
  for (const sessionId of activeSessionIds) interruptedAtQueryOrConfirmation.add(sessionId);
  windowsSessionEnding = true;
  confirmedRecoveryMarkerState = 'pending';
  for (const sessionId of interruptedAtQueryOrConfirmation) interruptedSessionIds.add(sessionId);
  for (const [sessionId, turnGenerations] of deferredTerminalTurnGenerations) {
    for (const turnGeneration of turnGenerations) {
      addConfirmedTerminalTurn(sessionId, turnGeneration);
    }
  }
  pendingQuerySessionTurnGenerations = null;
  pendingSilentStopContinuationGenerations.clear();
  deferredTerminalTurnGenerations.clear();
  return [...interruptedAtQueryOrConfirmation];
}

/**
 * Commit the confirmed-session-end handoff only after every recovery marker is
 * durable. A failed marker keeps the original terminal stream as the durable
 * fallback instead of leaving neither a marker nor a persisted failure.
 */
export function settleWindowsSessionEndRecoveryMarkers(durable: boolean): void {
  if (!windowsSessionEnding || confirmedRecoveryMarkerState !== 'pending') return;
  confirmedRecoveryMarkerState = durable ? 'durable' : 'fallback';
  if (!durable) confirmedTerminalTurnGenerations.clear();
  const callbacks = pendingEventCallbacks;
  pendingEventCallbacks = [];
  for (const callback of callbacks) {
    try {
      if (durable) callback.discard?.();
      else callback.replay();
    } catch (error) {
      log.warn(
        durable
          ? 'confirmed session-end event discard failed'
          : 'confirmed session-end fallback replay failed',
        error,
      );
    }
  }
}

export function shouldSuppressWindowsSessionEndClaudeError(context: {
  sessionId: string;
  source: string | undefined;
  isTerminalError: boolean;
}): boolean {
  return (
    windowsSessionEnding &&
    confirmedRecoveryMarkerState !== 'fallback' &&
    interruptedSessionIds.has(context.sessionId) &&
    context.source === 'claude-code' &&
    context.isTerminalError
  );
}

export function __resetWindowsSessionEndForTests(): void {
  for (const pendingEvent of pendingEventCallbacks) pendingEvent.discard?.();
  windowsSessionEnding = false;
  interruptedSessionIds.clear();
  pendingQuerySessionTurnGenerations = null;
  pendingSilentStopContinuationGenerations.clear();
  deferredTerminalTurnGenerations.clear();
  confirmedTerminalTurnGenerations.clear();
  confirmedRecoveryMarkerState = 'idle';
  pendingEventCallbacks = [];
}
