import type { AgentEvent } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetWindowsSessionEndForTests,
  beginWindowsSessionEndQuery,
  cancelWindowsSessionEndQuery,
  deferWindowsSessionEndEvent,
  finishWindowsSessionEndProductTurn,
  markWindowsSessionEnding,
  noteWindowsSessionEndTurnStarted,
  rollbackWindowsSessionEndTurnStarted,
  shouldSuppressWindowsSessionEndClaudeError,
} from '../windowsSessionEnd';

const claudeTerminalError: AgentEvent = {
  type: 'error',
  source: 'claude-code',
  data: { message: 'shutdown', isTerminal: true },
};
const claudeDone: AgentEvent = { type: 'done', source: 'claude-code', data: {} };
const claudeContinuationDone: AgentEvent = {
  ...claudeDone,
  turnContinuationId: 7,
};
const claudeSilentStopDone: AgentEvent = {
  ...claudeDone,
  data: { silentStop: true },
};
const claudeText: AgentEvent = {
  type: 'text',
  source: 'claude-code',
  data: { text: 'still running' },
};
const claudeIdleStatus: AgentEvent = {
  type: 'status',
  source: 'claude-code',
  data: { isRunning: false, status: 'Done' },
};

describe('Windows session-end terminal error classification', () => {
  beforeEach(() => {
    __resetWindowsSessionEndForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses only an active Claude terminal after Windows session end is observed', () => {
    const activeClaudeTerminal = {
      sessionId: 'active-session',
      source: 'claude-code',
      isTerminalError: true,
    };

    expect(shouldSuppressWindowsSessionEndClaudeError(activeClaudeTerminal)).toBe(false);

    expect(markWindowsSessionEnding(['active-session'])).toEqual(['active-session']);

    expect(shouldSuppressWindowsSessionEndClaudeError(activeClaudeTerminal)).toBe(true);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        ...activeClaudeTerminal,
        source: 'codex',
      }),
    ).toBe(false);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        ...activeClaudeTerminal,
        isTerminalError: false,
      }),
    ).toBe(false);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        ...activeClaudeTerminal,
        sessionId: 'already-idle-session',
      }),
    ).toBe(false);
  });

  it('drops confirmed shutdown terminal errors at the unified dispatch gate', () => {
    const replay = vi.fn();
    markWindowsSessionEnding(['active-session']);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, replay),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeIdleStatus, replay),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, replay),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'already-idle-session',
        'claude-code',
        claudeTerminalError,
        replay,
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent('active-session', 'codex', claudeTerminalError, replay),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeText, replay),
    ).toBe(false);
    expect(replay).not.toHaveBeenCalled();
  });

  it('allows a real normal completion after confirmation', () => {
    markWindowsSessionEnding(['active-session']);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, vi.fn()),
    ).toBe(false);
  });

  it('discards query-phase events when Windows confirms the session end', () => {
    const replay = vi.fn();
    const discard = vi.fn();

    beginWindowsSessionEndQuery(['active-session']);

    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeTerminalError,
        replay,
        discard,
      ),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, vi.fn()),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'already-idle-session',
        'claude-code',
        claudeTerminalError,
        vi.fn(),
      ),
    ).toBe(false);

    markWindowsSessionEnding(['active-session']);

    expect(replay).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('drops a deferred query error paired tail that arrives after confirmation', () => {
    const replay = vi.fn();
    beginWindowsSessionEndQuery(['active-session']);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, replay),
    ).toBe(true);
    markWindowsSessionEnding([]);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeIdleStatus, vi.fn()),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, vi.fn()),
    ).toBe(true);
    expect(replay).not.toHaveBeenCalled();
  });

  it('replays query-phase events in FIFO order when Windows cancels the request', () => {
    const calls: string[] = [];

    beginWindowsSessionEndQuery(['active-session']);
    deferWindowsSessionEndEvent(
      'active-session',
      'claude-code',
      claudeTerminalError,
      () => calls.push('terminal'),
    );
    deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, () =>
      calls.push('paired-done'),
    );

    expect(calls).toEqual([]);
    cancelWindowsSessionEndQuery();
    expect(calls).toEqual(['terminal', 'paired-done']);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeTerminalError,
        vi.fn(),
      ),
    ).toBe(false);
  });

  it('commits a normal done and excludes it from the interrupted snapshot', () => {
    const replay = vi.fn();
    beginWindowsSessionEndQuery(['active-session']);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, replay),
    ).toBe(false);
    expect(markWindowsSessionEnding([])).toEqual([]);
    expect(replay).not.toHaveBeenCalled();
  });

  it('protects a new Claude turn that starts after the query snapshot', () => {
    const replay = vi.fn();
    beginWindowsSessionEndQuery(['completed-session']);
    expect(
      deferWindowsSessionEndEvent('completed-session', 'claude-code', claudeDone, vi.fn()),
    ).toBe(false);

    expect(noteWindowsSessionEndTurnStarted('late-session', 'claude-code')).toBe(true);
    expect(noteWindowsSessionEndTurnStarted('codex-session', 'codex')).toBe(false);
    expect(
      deferWindowsSessionEndEvent('late-session', 'claude-code', claudeTerminalError, replay),
    ).toBe(true);

    expect(markWindowsSessionEnding([])).toEqual(['late-session']);
    expect(replay).not.toHaveBeenCalled();
  });

  it('rolls back a query-time turn that never dispatches', () => {
    beginWindowsSessionEndQuery([]);

    expect(noteWindowsSessionEndTurnStarted('undispatched-session', 'claude-code')).toBe(true);
    rollbackWindowsSessionEndTurnStarted('undispatched-session');

    expect(markWindowsSessionEnding([])).toEqual([]);
  });

  it('counts overlapping product turns independently', () => {
    beginWindowsSessionEndQuery(['overlap-session']);
    expect(noteWindowsSessionEndTurnStarted('overlap-session', 'claude-code')).toBe(true);

    expect(
      deferWindowsSessionEndEvent('overlap-session', 'claude-code', claudeDone, vi.fn()),
    ).toBe(false);
    expect(markWindowsSessionEnding([])).toEqual(['overlap-session']);
  });

  it('keeps a silent-stop replacement in the same product-turn slot', () => {
    beginWindowsSessionEndQuery(['silent-stop-session']);
    expect(
      deferWindowsSessionEndEvent(
        'silent-stop-session',
        'claude-code',
        claudeSilentStopDone,
        vi.fn(),
      ),
    ).toBe(false);
    expect(noteWindowsSessionEndTurnStarted('silent-stop-session', 'claude-code')).toBe(false);

    finishWindowsSessionEndProductTurn('silent-stop-session');

    expect(markWindowsSessionEnding([])).toEqual([]);
  });

  it('keeps a continuation boundary in the interrupted snapshot', () => {
    const terminalReplay = vi.fn();
    beginWindowsSessionEndQuery(['active-session']);

    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeContinuationDone,
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeTerminalError,
        terminalReplay,
      ),
    ).toBe(true);

    expect(markWindowsSessionEnding([])).toEqual(['active-session']);
    expect(terminalReplay).not.toHaveBeenCalled();
  });

  it('keeps a silent-stop boundary in the interrupted snapshot', () => {
    const terminalReplay = vi.fn();
    beginWindowsSessionEndQuery(['active-session']);

    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeSilentStopDone,
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeTerminalError,
        terminalReplay,
      ),
    ).toBe(true);

    expect(markWindowsSessionEnding([])).toEqual(['active-session']);
    expect(terminalReplay).not.toHaveBeenCalled();
  });

  it('passes high-volume non-terminal events through without dropping query protection', () => {
    const replay = vi.fn();

    beginWindowsSessionEndQuery(['active-session']);
    for (let index = 0; index < 128; index += 1) {
      expect(
        deferWindowsSessionEndEvent('active-session', 'claude-code', claudeText, vi.fn()),
      ).toBe(false);
    }
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, replay),
    ).toBe(true);

    markWindowsSessionEnding([]);

    expect(replay).not.toHaveBeenCalled();
  });

  it('retains the query-time active snapshot through confirmation', () => {
    beginWindowsSessionEndQuery(['query-time-session']);

    expect(markWindowsSessionEnding(['confirmation-time-session'])).toEqual([
      'query-time-session',
      'confirmation-time-session',
    ]);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        sessionId: 'query-time-session',
        source: 'claude-code',
        isTerminalError: true,
      }),
    ).toBe(true);
  });

  it('contains cancellation replay failures and continues replaying later callbacks', () => {
    const afterFailure = vi.fn();

    beginWindowsSessionEndQuery(['active-session']);
    deferWindowsSessionEndEvent(
      'active-session',
      'claude-code',
      claudeTerminalError,
      () => {
        throw new Error('listener failed');
      },
    );
    deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, afterFailure);

    expect(() => cancelWindowsSessionEndQuery()).not.toThrow();
    expect(afterFailure).toHaveBeenCalledTimes(1);
  });

  it('keeps query evidence across an arbitrarily late confirmation', () => {
    vi.useFakeTimers();
    const replay = vi.fn();
    beginWindowsSessionEndQuery(['active-session']);
    deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, replay);

    vi.advanceTimersByTime(60_000);

    expect(replay).not.toHaveBeenCalled();
    expect(markWindowsSessionEnding([])).toEqual(['active-session']);
    expect(replay).not.toHaveBeenCalled();
  });
});
