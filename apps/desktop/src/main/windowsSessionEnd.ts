/**
 * Process-local coordination for Windows shutdown, restart, and logoff.
 * Query events are reversible, so active-session events are held briefly until
 * Windows either confirms the session end or the query window expires. The
 * confirmed flag remains monotonic for the rest of the process lifetime.
 */
const MAX_PENDING_EVENT_CALLBACKS = 128;

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
  let replayFailed = false;
  let firstError: unknown;
  for (const replay of callbacks) {
    try {
      replay();
    } catch (error) {
      replayFailed = true;
      firstError ??= error;
    }
  }
  if (replayFailed) throw firstError;
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

export function deferWindowsSessionEndEvent(sessionId: string, replay: () => void): boolean {
  if (!pendingQuerySessionIds?.has(sessionId)) return false;
  pendingEventCallbacks.push(replay);
  if (pendingEventCallbacks.length >= MAX_PENDING_EVENT_CALLBACKS) {
    // Fail open without reordering: replay the complete FIFO, including this
    // callback, before allowing later events through normally.
    replayPendingQueryEvents();
  }
  return true;
}

export function markWindowsSessionEnding(activeSessionIds: Iterable<string>): void {
  windowsSessionEnding = true;
  for (const sessionId of activeSessionIds) interruptedSessionIds.add(sessionId);
  clearPendingQueryTimer();
  pendingQuerySessionIds = null;
  pendingEventCallbacks = [];
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
