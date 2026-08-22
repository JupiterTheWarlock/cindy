import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetWindowsSessionEndForTests,
  beginWindowsSessionEndQuery,
  deferWindowsSessionEndEvent,
  markWindowsSessionEnding,
  shouldSuppressWindowsSessionEndClaudeError,
} from '../windowsSessionEnd';

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

  it('discards query-phase events when Windows confirms the session end', () => {
    const replay = vi.fn();

    beginWindowsSessionEndQuery(['active-session'], 1_000);

    expect(deferWindowsSessionEndEvent('active-session', true, replay)).toBe(true);
    expect(deferWindowsSessionEndEvent('already-idle-session', true, vi.fn())).toBe(false);

    markWindowsSessionEnding(['active-session']);

    expect(replay).not.toHaveBeenCalled();
  });

  it('replays query-phase events in FIFO order when no confirmation arrives', () => {
    vi.useFakeTimers();
    const calls: string[] = [];

    beginWindowsSessionEndQuery(['active-session'], 50);
    deferWindowsSessionEndEvent('active-session', true, () => calls.push('terminal'));
    deferWindowsSessionEndEvent('active-session', true, () => calls.push('paired-done'));

    vi.advanceTimersByTime(49);
    expect(calls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['terminal', 'paired-done']);
    expect(deferWindowsSessionEndEvent('active-session', true, vi.fn())).toBe(false);
  });

  it('passes high-volume non-terminal events through without dropping query protection', () => {
    const replay = vi.fn();

    beginWindowsSessionEndQuery(['active-session'], 1_000);
    for (let index = 0; index < 128; index += 1) {
      expect(deferWindowsSessionEndEvent('active-session', false, vi.fn())).toBe(false);
    }
    expect(deferWindowsSessionEndEvent('active-session', true, replay)).toBe(true);

    markWindowsSessionEnding([]);

    expect(replay).not.toHaveBeenCalled();
  });

  it('retains the query-time active snapshot through confirmation', () => {
    beginWindowsSessionEndQuery(['query-time-session'], 1_000);

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

  it('contains replay failures and continues replaying later callbacks', () => {
    vi.useFakeTimers();
    const afterFailure = vi.fn();

    beginWindowsSessionEndQuery(['active-session'], 50);
    deferWindowsSessionEndEvent('active-session', true, () => {
      throw new Error('listener failed');
    });
    deferWindowsSessionEndEvent('active-session', true, afterFailure);

    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
    expect(afterFailure).toHaveBeenCalledTimes(1);
  });
});
