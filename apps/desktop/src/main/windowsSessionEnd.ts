/**
 * Process-local coordination for Windows shutdown, restart, and logoff.
 * Query events are reversible, so terminal-sensitive active-session events are
 * held briefly until Windows either confirms the session end or the query
 * window expires. The confirmed flag remains monotonic for the rest of the
 * process lifetime.
 */
import type { AgentEvent, AgentKind } from '@cindy/maker-core';

import { createLogger } from './logger.js';

const log = createLogger('windows-session-end');

let windowsSessionEnding = false;
const interruptedSessionIds = new Set<string>();
let pendingQuerySessionIds: Set<string> | null = null;
const deferredTerminalSessionIds = new Set<string>();
const confirmedTerminalSessionIds = new Set<string>();
let pendingEventCallbacks: Array<() => void> = [];
let pendingQueryTimer: ReturnType<typeof setTimeout> | null = null;

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

function clearPendingQueryTimer(): void {
  if (!pendingQueryTimer) return;
  clearTimeout(pendingQueryTimer);
  pendingQueryTimer = null;
}

function replayPendingQueryEvents(): void {
  clearPendingQueryTimer();
  pendingQuerySessionIds = null;
  deferredTerminalSessionIds.clear();
  const callbacks = pendingEventCallbacks;
  pendingEventCallbacks = [];
  for (const replay of callbacks) {
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
  activeSessionIds: Iterable<string>,
  timeoutMs: number,
): void {
  if (windowsSessionEnding) return;
  if (pendingQuerySessionIds) {
    for (const sessionId of activeSessionIds) pendingQuerySessionIds.add(sessionId);
    return;
  }
  pendingQuerySessionIds = new Set(activeSessionIds);
  pendingQueryTimer = setTimeout(replayPendingQueryEvents, timeoutMs);
}

export function deferWindowsSessionEndEvent(
  sessionId: string,
  agentKind: AgentKind,
  event: AgentEvent,
  replay: () => void,
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
  if (!pendingQuerySessionIds?.has(sessionId)) return false;
  if (isTerminalAgentErrorEvent(event)) {
    deferredTerminalSessionIds.add(sessionId);
    pendingEventCallbacks.push(replay);
    return true;
  }
  if (event.type !== 'done') return false;
  if (deferredTerminalSessionIds.has(sessionId)) {
    pendingEventCallbacks.push(replay);
    return true;
  }
  // A claim-bearing or silent-stop done is only an SDK continuation boundary;
  // the product turn remains active, so keep the query-time snapshot protected
  // until an unclaimed terminal done or Windows confirmation arrives.
  if (event.turnContinuationId !== undefined || isSilentStopDoneEvent(event)) return false;
  // An unclaimed done without a preceding terminal error completed normally
  // during the advisory query. Let consumers commit it and exclude it from
  // interruption.
  pendingQuerySessionIds.delete(sessionId);
  return false;
}

export function markWindowsSessionEnding(activeSessionIds: Iterable<string>): string[] {
  const interruptedAtQueryOrConfirmation = new Set(pendingQuerySessionIds ?? []);
  for (const sessionId of activeSessionIds) interruptedAtQueryOrConfirmation.add(sessionId);
  windowsSessionEnding = true;
  for (const sessionId of interruptedAtQueryOrConfirmation) interruptedSessionIds.add(sessionId);
  for (const sessionId of deferredTerminalSessionIds) confirmedTerminalSessionIds.add(sessionId);
  clearPendingQueryTimer();
  pendingQuerySessionIds = null;
  deferredTerminalSessionIds.clear();
  pendingEventCallbacks = [];
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
  clearPendingQueryTimer();
  windowsSessionEnding = false;
  interruptedSessionIds.clear();
  pendingQuerySessionIds = null;
  deferredTerminalSessionIds.clear();
  confirmedTerminalSessionIds.clear();
  pendingEventCallbacks = [];
}
