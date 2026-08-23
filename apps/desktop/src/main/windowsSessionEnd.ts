/**
 * Process-local coordination for Windows shutdown, restart, and logoff.
 * Query events are reversible, so terminal-sensitive active-session events are
 * held until WM_ENDSESSION reports whether Windows confirmed or cancelled the
 * request. The confirmed flag remains monotonic for the rest of the process
 * lifetime.
 */
import type { AgentEvent, AgentKind } from '@cindy/maker-core';

import { createLogger } from './logger.js';

const log = createLogger('windows-session-end');

let windowsSessionEnding = false;
const interruptedSessionIds = new Set<string>();
let pendingQuerySessionTurnCounts: Map<string, number> | null = null;
const pendingSilentStopContinuationSessionIds = new Set<string>();
const deferredTerminalSessionIds = new Set<string>();
const confirmedTerminalSessionIds = new Set<string>();
let pendingEventCallbacks: Array<{ replay: () => void; discard?: () => void }> = [];

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
  pendingQuerySessionTurnCounts = null;
  pendingSilentStopContinuationSessionIds.clear();
  deferredTerminalSessionIds.clear();
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

export function beginWindowsSessionEndQuery(activeSessionIds: Iterable<string>): void {
  if (windowsSessionEnding) return;
  if (pendingQuerySessionTurnCounts) {
    // Repeated advisory messages describe the same currently active turns.
    // Ensure membership without double-counting an existing generation.
    for (const sessionId of activeSessionIds) {
      if (!pendingQuerySessionTurnCounts.has(sessionId)) {
        pendingQuerySessionTurnCounts.set(sessionId, 1);
      }
    }
    return;
  }
  pendingQuerySessionTurnCounts = new Map([...activeSessionIds].map((sessionId) => [sessionId, 1]));
}

/** Keep turns dispatched during the advisory query inside the protected snapshot. */
export function noteWindowsSessionEndTurnStarted(sessionId: string, agentKind: AgentKind): boolean {
  if (windowsSessionEnding || agentKind !== 'claude-code' || !pendingQuerySessionTurnCounts) {
    return false;
  }
  // The replacement request after silent-stop is the same product turn. Its
  // eventual normal done owns the existing count, while a failed dispatch is
  // settled by finishWindowsSessionEndProductTurn().
  if (pendingSilentStopContinuationSessionIds.delete(sessionId)) {
    if (!pendingQuerySessionTurnCounts.has(sessionId)) {
      pendingQuerySessionTurnCounts.set(sessionId, 1);
    }
    return false;
  }
  pendingQuerySessionTurnCounts.set(
    sessionId,
    (pendingQuerySessionTurnCounts.get(sessionId) ?? 0) + 1,
  );
  return true;
}

/** Roll back a query-time turn reservation that never reached its provider. */
export function rollbackWindowsSessionEndTurnStarted(sessionId: string): void {
  finishWindowsSessionEndProductTurn(sessionId);
}

/** Retire one completed Claude product turn from the advisory snapshot. */
export function finishWindowsSessionEndProductTurn(sessionId: string): void {
  if (windowsSessionEnding || !pendingQuerySessionTurnCounts) return;
  const count = pendingQuerySessionTurnCounts.get(sessionId);
  if (count === undefined) return;
  if (count > 1) {
    pendingQuerySessionTurnCounts.set(sessionId, count - 1);
    return;
  }
  pendingQuerySessionTurnCounts.delete(sessionId);
  pendingSilentStopContinuationSessionIds.delete(sessionId);
}

/** WM_ENDSESSION(wParam=FALSE) is the authoritative cancellation signal. */
export function cancelWindowsSessionEndQuery(): void {
  if (windowsSessionEnding || !pendingQuerySessionTurnCounts) return;
  replayPendingQueryEvents();
}

export function deferWindowsSessionEndEvent(
  sessionId: string,
  agentKind: AgentKind,
  event: AgentEvent,
  replay: () => void,
  discard?: () => void,
): boolean {
  if (agentKind !== 'claude-code') return false;
  // Confirmation is irreversible. Keep shutdown-generated terminal failures out
  // of Session's unified fan-out until the protected session is detached; the
  // interrupted marker is the authoritative restart state for these turns.
  if (windowsSessionEnding && interruptedSessionIds.has(sessionId)) {
    if (isTerminalAgentErrorEvent(event)) {
      confirmedTerminalSessionIds.add(sessionId);
      return true;
    }
    // Claude closes a terminal failure with status:isRunning=false and done.
    // Once its error was suppressed, drop that paired tail at the same unified
    // boundary; a normal done without a preceding shutdown error still passes.
    if (
      confirmedTerminalSessionIds.has(sessionId) &&
      (isTerminalStatusEvent(event) || event.type === 'done')
    ) {
      return true;
    }
  }
  if (!pendingQuerySessionTurnCounts?.has(sessionId)) return false;
  if (isTerminalAgentErrorEvent(event)) {
    deferredTerminalSessionIds.add(sessionId);
    pendingEventCallbacks.push({ replay, discard });
    return true;
  }
  if (event.type !== 'done') return false;
  if (deferredTerminalSessionIds.has(sessionId)) {
    pendingEventCallbacks.push({ replay, discard });
    return true;
  }
  // A claim-bearing or silent-stop done is only an SDK continuation boundary;
  // the product turn remains active, so keep the query-time snapshot protected
  // until an unclaimed terminal done or Windows confirmation arrives.
  if (event.turnContinuationId !== undefined) return false;
  if (isSilentStopDoneEvent(event)) {
    pendingSilentStopContinuationSessionIds.add(sessionId);
    return false;
  }
  // An unclaimed done without a preceding terminal error completed normally
  // during the advisory query. Let consumers commit it and exclude it from
  // interruption.
  finishWindowsSessionEndProductTurn(sessionId);
  return false;
}

export function markWindowsSessionEnding(activeSessionIds: Iterable<string>): string[] {
  const interruptedAtQueryOrConfirmation = new Set(pendingQuerySessionTurnCounts?.keys() ?? []);
  for (const sessionId of activeSessionIds) interruptedAtQueryOrConfirmation.add(sessionId);
  windowsSessionEnding = true;
  for (const sessionId of interruptedAtQueryOrConfirmation) interruptedSessionIds.add(sessionId);
  for (const sessionId of deferredTerminalSessionIds) confirmedTerminalSessionIds.add(sessionId);
  pendingQuerySessionTurnCounts = null;
  pendingSilentStopContinuationSessionIds.clear();
  deferredTerminalSessionIds.clear();
  const pendingEvents = pendingEventCallbacks;
  pendingEventCallbacks = [];
  for (const pendingEvent of pendingEvents) pendingEvent.discard?.();
  return [...interruptedAtQueryOrConfirmation];
}

export function shouldSuppressWindowsSessionEndClaudeError(context: {
  sessionId: string;
  source: string | undefined;
  isTerminalError: boolean;
}): boolean {
  return (
    windowsSessionEnding &&
    interruptedSessionIds.has(context.sessionId) &&
    context.source === 'claude-code' &&
    context.isTerminalError
  );
}

export function __resetWindowsSessionEndForTests(): void {
  for (const pendingEvent of pendingEventCallbacks) pendingEvent.discard?.();
  windowsSessionEnding = false;
  interruptedSessionIds.clear();
  pendingQuerySessionTurnCounts = null;
  pendingSilentStopContinuationSessionIds.clear();
  deferredTerminalSessionIds.clear();
  confirmedTerminalSessionIds.clear();
  pendingEventCallbacks = [];
}
