// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  shortcutHandler: null as ((event: KeyboardEvent) => boolean) | null,
  resultHandler: null as
    | ((result: {
        requestId: number;
        activeMatchOrdinal: number;
        matches: number;
        finalUpdate: boolean;
      }) => void)
    | null,
  findInPage: vi.fn(),
  stopFindInPage: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAppShortcut', () => ({
  useAppShortcut: (_id: string, handler: (event: KeyboardEvent) => boolean) => {
    mocks.shortcutHandler = handler;
  },
}));

vi.mock('@/components/find-in-page/findInPageOwnership', () => ({
  isFindInPageClaimed: () => false,
}));

import { FindInPageBar } from '../FindInPageBar';

async function openFindBar(): Promise<HTMLInputElement> {
  render(<FindInPageBar />);
  await act(async () => {
    expect(mocks.shortcutHandler?.(new KeyboardEvent('keydown'))).toBe(true);
    await Promise.resolve();
  });
  return screen.getByPlaceholderText('findInPage.placeholder') as HTMLInputElement;
}

describe('FindInPageBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.shortcutHandler = null;
    mocks.resultHandler = null;
    mocks.findInPage.mockResolvedValue(41);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        findInPage: mocks.findInPage,
        stopFindInPage: mocks.stopFindInPage,
        onFindInPageResult: (handler: NonNullable<typeof mocks.resultHandler>) => {
          mocks.resultHandler = handler;
          return () => {
            if (mocks.resultHandler === handler) mocks.resultHandler = null;
          };
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('excludes the query input from native search and restores its caret after finalUpdate', async () => {
    const input = await openFindBar();
    input.focus();
    fireEvent.change(input, { target: { value: 'foo' } });
    input.setSelectionRange(2, 2);

    expect(mocks.findInPage).not.toHaveBeenCalled();
    mocks.findInPage.mockImplementationOnce(async () => {
      expect(input.inert).toBe(true);
      return 41;
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    expect(mocks.findInPage).toHaveBeenCalledWith({
      text: 'foo',
      forward: true,
      findNext: false,
    });
    expect(input.inert).toBe(true);

    // Chromium moves focus to the active page match while searching.
    input.blur();
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 2,
        finalUpdate: true,
      });
    });

    expect(input.inert).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
    expect(screen.getByText('1/2')).toBeTruthy();
  });

  it('cancels the delayed search when the query is cleared', async () => {
    const input = await openFindBar();
    fireEvent.change(input, { target: { value: 'foo' } });
    fireEvent.change(input, { target: { value: '' } });

    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });

    expect(mocks.findInPage).not.toHaveBeenCalled();
    expect(mocks.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });

  it('ignores late results from the previous query during the debounce window', async () => {
    const input = await openFindBar();
    fireEvent.change(input, { target: { value: 'foo' } });
    await act(async () => {
      vi.advanceTimersByTime(120);
      await Promise.resolve();
    });
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 1,
        matches: 2,
        finalUpdate: true,
      });
    });
    expect(screen.getByText('1/2')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'bar' } });
    act(() => {
      mocks.resultHandler?.({
        requestId: 41,
        activeMatchOrdinal: 2,
        matches: 99,
        finalUpdate: true,
      });
    });

    expect(screen.queryByText('2/99')).toBeNull();
    expect(screen.queryByText('1/2')).toBeNull();
  });
});
