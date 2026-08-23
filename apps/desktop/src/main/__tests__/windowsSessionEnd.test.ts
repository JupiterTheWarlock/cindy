import type { AgentEvent } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetWindowsSessionEndForTests,
  beginWindowsSessionEndQuery,
  cancelWindowsSessionEndQuery,
  createWindowsSessionEndEventGate,
  deferWindowsSessionEndEvent,
  finishWindowsSessionEndProductTurn,
  markWindowsSessionEnding,
  noteWindowsSessionEndTurnStarted,
  rollbackWindowsSessionEndTurnStarted,
  settleWindowsSessionEndRecoveryMarkers,
  shouldSuppressWindowsSessionEndClaudeError,
} from '../windowsSessionEnd';

const claudeTerminalError: AgentEvent = {
  type: 'error',
  source: 'claude-code',
  data: { message: 'shutdown', isTerminal: true },
  sessionTurnGeneration: 1,
};
const claudeDone: AgentEvent = {
  type: 'done',
  source: 'claude-code',
  data: {},
  sessionTurnGeneration: 1,
};
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
  sessionTurnGeneration: 1,
};
const claudeIdleStatus: AgentEvent = {
  type: 'status',
  source: 'claude-code',
  data: { isRunning: false, status: 'Done' },
  sessionTurnGeneration: 1,
};

const activeTurn = (sessionId: string, turnGeneration = 1) => ({
  sessionId,
  turnGeneration,
});

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
      sessionTurnGeneration: 1,
    };

    expect(shouldSuppressWindowsSessionEndClaudeError(activeClaudeTerminal)).toBe(false);

    expect(markWindowsSessionEnding([activeTurn('active-session')])).toEqual(['active-session']);

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

  it('drops confirmed shutdown terminal errors at the unified dispatch gate', async () => {
    const replay = vi.fn();
    markWindowsSessionEnding([activeTurn('active-session')]);

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
    await settleWindowsSessionEndRecoveryMarkers(['active-session']);
    expect(replay).not.toHaveBeenCalled();
  });

  it('does not drop a newer turn generation behind a confirmed terminal tail', () => {
    markWindowsSessionEnding([activeTurn('active-session')]);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, vi.fn()),
    ).toBe(true);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        { ...claudeIdleStatus, sessionTurnGeneration: 2 },
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        { ...claudeDone, sessionTurnGeneration: 2 },
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeIdleStatus, vi.fn()),
    ).toBe(true);
    expect(deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, vi.fn())).toBe(
      true,
    );
  });

  it('holds a normal completion for a generation active at confirmation', async () => {
    const replay = vi.fn();
    const discard = vi.fn();
    markWindowsSessionEnding([activeTurn('active-session')]);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, replay, discard),
    ).toBe(true);
    await settleWindowsSessionEndRecoveryMarkers(['active-session']);
    expect(replay).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('discards query-phase events when Windows confirms the session end', async () => {
    const replay = vi.fn();
    const discard = vi.fn();
    const statusReplay = vi.fn();
    const statusDiscard = vi.fn();

    beginWindowsSessionEndQuery([activeTurn('active-session')]);

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
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        claudeIdleStatus,
        statusReplay,
        statusDiscard,
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

    markWindowsSessionEnding([activeTurn('active-session')]);

    expect(discard).not.toHaveBeenCalled();
    await settleWindowsSessionEndRecoveryMarkers(['active-session']);

    expect(replay).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(statusReplay).not.toHaveBeenCalled();
    expect(statusDiscard).toHaveBeenCalledTimes(1);
  });

  it('replays held terminal state when the confirmed recovery marker fails', async () => {
    const calls: string[] = [];
    const discard = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('active-session')]);
    deferWindowsSessionEndEvent(
      'active-session',
      'claude-code',
      claudeTerminalError,
      () => calls.push('terminal'),
      discard,
    );
    deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, () =>
      calls.push('done'),
    );

    markWindowsSessionEnding([]);
    await expect(settleWindowsSessionEndRecoveryMarkers([])).resolves.toEqual(['active-session']);

    expect(calls).toEqual(['terminal', 'done']);
    expect(discard).not.toHaveBeenCalled();
    expect(
      deferWindowsSessionEndEvent(
        'active-session',
        'claude-code',
        { ...claudeTerminalError, sessionTurnGeneration: 2 },
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        sessionId: 'active-session',
        source: 'claude-code',
        isTerminalError: true,
        sessionTurnGeneration: 1,
      }),
    ).toBe(false);
  });

  it('waits for a late terminal before settling a failed recovery marker', async () => {
    const replay = vi.fn();
    markWindowsSessionEnding([activeTurn('active-session')]);

    const settlement = settleWindowsSessionEndRecoveryMarkers([]);
    let settled = false;
    void settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, replay),
    ).toBe(true);
    await expect(settlement).resolves.toEqual(['active-session']);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        sessionId: 'active-session',
        source: 'claude-code',
        isTerminalError: true,
        sessionTurnGeneration: 1,
      }),
    ).toBe(false);
  });

  it('settles each late fallback without waiting for another session', async () => {
    const calls: string[] = [];
    markWindowsSessionEnding([activeTurn('first-session'), activeTurn('second-session')]);

    const settlement = settleWindowsSessionEndRecoveryMarkers([], async (sessionId) => {
      calls.push(`settled:${sessionId}`);
    });
    expect(
      deferWindowsSessionEndEvent(
        'first-session',
        'claude-code',
        claudeTerminalError,
        () => calls.push('replayed:first-session'),
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(calls).toEqual(['replayed:first-session', 'settled:first-session']),
    );

    expect(
      deferWindowsSessionEndEvent(
        'second-session',
        'claude-code',
        claudeTerminalError,
        () => calls.push('replayed:second-session'),
      ),
    ).toBe(true);
    await expect(settlement).resolves.toEqual(['first-session', 'second-session']);
    expect(calls).toEqual([
      'replayed:first-session',
      'settled:first-session',
      'replayed:second-session',
      'settled:second-session',
    ]);
  });

  it('settles recovery marker outcomes independently per session', async () => {
    const durableReplay = vi.fn();
    const durableDiscard = vi.fn();
    const failedReplay = vi.fn();
    const failedDiscard = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('durable-session'), activeTurn('failed-session')]);
    deferWindowsSessionEndEvent(
      'durable-session',
      'claude-code',
      claudeTerminalError,
      durableReplay,
      durableDiscard,
    );
    deferWindowsSessionEndEvent(
      'failed-session',
      'claude-code',
      claudeTerminalError,
      failedReplay,
      failedDiscard,
    );

    markWindowsSessionEnding([]);
    await expect(settleWindowsSessionEndRecoveryMarkers(['durable-session'])).resolves.toEqual([
      'failed-session',
    ]);

    expect(durableReplay).not.toHaveBeenCalled();
    expect(durableDiscard).toHaveBeenCalledTimes(1);
    expect(failedReplay).toHaveBeenCalledTimes(1);
    expect(failedDiscard).not.toHaveBeenCalled();
  });

  it('drops a deferred query error paired tail that arrives after confirmation', () => {
    const replay = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('active-session')]);

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

    beginWindowsSessionEndQuery([activeTurn('active-session')]);
    deferWindowsSessionEndEvent(
      'active-session',
      'claude-code',
      claudeTerminalError,
      () => calls.push('terminal'),
    );
    deferWindowsSessionEndEvent('active-session', 'claude-code', claudeIdleStatus, () =>
      calls.push('paired-status'),
    );
    deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, () =>
      calls.push('paired-done'),
    );

    expect(calls).toEqual([]);
    cancelWindowsSessionEndQuery();
    expect(calls).toEqual(['terminal', 'paired-status', 'paired-done']);
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
    beginWindowsSessionEndQuery([activeTurn('active-session')]);

    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeDone, replay),
    ).toBe(false);
    expect(markWindowsSessionEnding([])).toEqual([]);
    expect(replay).not.toHaveBeenCalled();
  });

  it('does not let a stale done retire the query-time current generation', () => {
    const replay = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('generation-race', 2)]);

    expect(
      deferWindowsSessionEndEvent(
        'generation-race',
        'claude-code',
        { ...claudeDone, sessionTurnGeneration: 1 },
        vi.fn(),
      ),
    ).toBe(false);
    expect(
      deferWindowsSessionEndEvent(
        'generation-race',
        'claude-code',
        { ...claudeTerminalError, sessionTurnGeneration: 2 },
        replay,
      ),
    ).toBe(true);

    expect(markWindowsSessionEnding([])).toEqual(['generation-race']);
    expect(replay).not.toHaveBeenCalled();
  });

  it('protects a new Claude turn that starts after the query snapshot', () => {
    const replay = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('completed-session')]);
    expect(
      deferWindowsSessionEndEvent('completed-session', 'claude-code', claudeDone, vi.fn()),
    ).toBe(false);

    expect(noteWindowsSessionEndTurnStarted('late-session', 'claude-code', 1)).toBe(true);
    expect(noteWindowsSessionEndTurnStarted('codex-session', 'codex', 1)).toBe(false);
    expect(
      deferWindowsSessionEndEvent('late-session', 'claude-code', claudeTerminalError, replay),
    ).toBe(true);

    expect(markWindowsSessionEnding([])).toEqual(['late-session']);
    expect(replay).not.toHaveBeenCalled();
  });

  it('rolls back a query-time turn that never dispatches', () => {
    beginWindowsSessionEndQuery([]);

    expect(noteWindowsSessionEndTurnStarted('undispatched-session', 'claude-code', 1)).toBe(true);
    rollbackWindowsSessionEndTurnStarted('undispatched-session', 1);

    expect(markWindowsSessionEnding([])).toEqual([]);
  });

  it('counts overlapping product turns independently', () => {
    beginWindowsSessionEndQuery([activeTurn('overlap-session')]);
    expect(noteWindowsSessionEndTurnStarted('overlap-session', 'claude-code', 2)).toBe(true);

    expect(
      deferWindowsSessionEndEvent('overlap-session', 'claude-code', claudeDone, vi.fn()),
    ).toBe(false);
    expect(markWindowsSessionEnding([])).toEqual(['overlap-session']);
  });

  it('keeps a silent-stop replacement in the same product-turn slot', () => {
    beginWindowsSessionEndQuery([activeTurn('silent-stop-session')]);
    expect(
      deferWindowsSessionEndEvent(
        'silent-stop-session',
        'claude-code',
        claudeSilentStopDone,
        vi.fn(),
      ),
    ).toBe(false);
    expect(noteWindowsSessionEndTurnStarted('silent-stop-session', 'claude-code', 2)).toBe(false);

    finishWindowsSessionEndProductTurn('silent-stop-session');

    expect(markWindowsSessionEnding([])).toEqual([]);
  });

  it('keeps a continuation boundary in the interrupted snapshot', () => {
    const terminalReplay = vi.fn();
    beginWindowsSessionEndQuery([activeTurn('active-session')]);

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
    beginWindowsSessionEndQuery([activeTurn('active-session')]);

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
    const gate = createWindowsSessionEndEventGate('active-session', 'claude-code');

    beginWindowsSessionEndQuery([activeTurn('active-session')]);
    for (let index = 0; index < 128; index += 1) {
      expect(gate.shouldRun?.(claudeText)).toBe(false);
      expect(
        deferWindowsSessionEndEvent('active-session', 'claude-code', claudeText, vi.fn()),
      ).toBe(false);
    }
    expect(gate.shouldRun?.(claudeTerminalError)).toBe(true);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, replay),
    ).toBe(true);
    expect(gate.shouldRun?.(claudeIdleStatus)).toBe(true);
    expect(
      deferWindowsSessionEndEvent('active-session', 'claude-code', claudeIdleStatus, vi.fn()),
    ).toBe(true);

    markWindowsSessionEnding([]);

    expect(replay).not.toHaveBeenCalled();
  });

  it('retains the query-time active snapshot through confirmation', () => {
    beginWindowsSessionEndQuery([activeTurn('query-time-session')]);

    expect(markWindowsSessionEnding([activeTurn('confirmation-time-session')])).toEqual([
      'query-time-session',
      'confirmation-time-session',
    ]);
    expect(
      shouldSuppressWindowsSessionEndClaudeError({
        sessionId: 'query-time-session',
        source: 'claude-code',
        isTerminalError: true,
        sessionTurnGeneration: 1,
      }),
    ).toBe(true);
  });

  it('contains cancellation replay failures and continues replaying later callbacks', () => {
    const afterFailure = vi.fn();

    beginWindowsSessionEndQuery([activeTurn('active-session')]);
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
    beginWindowsSessionEndQuery([activeTurn('active-session')]);
    deferWindowsSessionEndEvent('active-session', 'claude-code', claudeTerminalError, replay);

    vi.advanceTimersByTime(60_000);

    expect(replay).not.toHaveBeenCalled();
    expect(markWindowsSessionEnding([])).toEqual(['active-session']);
    expect(replay).not.toHaveBeenCalled();
  });
});
