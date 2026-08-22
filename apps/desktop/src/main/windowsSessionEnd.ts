/**
 * Process-local coordination for Windows shutdown, restart, and logoff.
 * Query events are reversible, so terminal-sensitive active-session events are
 * held briefly until Windows either confirms the session end or the query
 * window expires. The confirmed flag remains monotonic for the rest of the
 * process lifetime.
 */
import { createLogger } from './logger.js';

const log = createLogger('windows-session-end');

let windowsSessionEnding = false;
const interruptedSessionIds = new Set<string>();
let pendingQuerySessionIds: Set<string> | null = null;
let pendingEventCallbacks: Array<() => void> = [];
let pendingQueryTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingQueryTimer(): void {
  if (!pendingQueryTimer) return;
  clearTimeout(pendingQueryTimer);
  pendingQueryTimer = null;
}

function replayPendingQueryEvents(): void {
  clearPendingQueryTimer();
  pendingQuerySessionIds = null;
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
  terminalSensitive: boolean,
  replay: () => void,
): boolean {
  if (!terminalSensitive || !pendingQuerySessionIds?.has(sessionId)) return false;
  pendingEventCallbacks.push(replay);
  return true;
}

export function markWindowsSessionEnding(activeSessionIds: Iterable<string>): string[] {
  const interruptedAtQueryOrConfirmation = new Set(pendingQuerySessionIds ?? []);
  for (const sessionId of activeSessionIds) interruptedAtQueryOrConfirmation.add(sessionId);
  windowsSessionEnding = true;
  for (const sessionId of interruptedAtQueryOrConfirmation) interruptedSessionIds.add(sessionId);
  clearPendingQueryTimer();
  pendingQuerySessionIds = null;
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
  pendingEventCallbacks = [];
}
