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

    markWindowsSessionEnding(['active-session']);

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

    expect(deferWindowsSessionEndEvent('active-session', replay)).toBe(true);
    expect(deferWindowsSessionEndEvent('already-idle-session', vi.fn())).toBe(false);

    markWindowsSessionEnding(['active-session']);

    expect(replay).not.toHaveBeenCalled();
  });

  it('replays query-phase events in FIFO order when no confirmation arrives', () => {
    vi.useFakeTimers();
    const calls: string[] = [];

    beginWindowsSessionEndQuery(['active-session'], 50);
    deferWindowsSessionEndEvent('active-session', () => calls.push('terminal'));
    deferWindowsSessionEndEvent('active-session', () => calls.push('paired-done'));

    vi.advanceTimersByTime(49);
    expect(calls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['terminal', 'paired-done']);
    expect(deferWindowsSessionEndEvent('active-session', vi.fn())).toBe(false);
  });

  it('fails open in FIFO order when the bounded query queue fills', () => {
    const calls: number[] = [];

    beginWindowsSessionEndQuery(['active-session'], 1_000);
    for (let index = 0; index < 128; index += 1) {
      expect(
        deferWindowsSessionEndEvent('active-session', () => {
          calls.push(index);
        }),
      ).toBe(true);
    }

    expect(calls).toEqual(Array.from({ length: 128 }, (_, index) => index));
    expect(deferWindowsSessionEndEvent('active-session', vi.fn())).toBe(false);
  });
});
