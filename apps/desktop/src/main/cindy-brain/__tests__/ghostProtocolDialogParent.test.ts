import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  focused: null as FakeWindow | null,
  windows: [] as FakeWindow[],
}));

interface FakeWindow {
  trusted: boolean;
  visible: boolean;
  url: string;
  isVisible(): boolean;
  webContents: { getURL(): string };
}

function fakeWindow(args: { trusted?: boolean; visible?: boolean; url?: string } = {}): FakeWindow {
  const window = {
    trusted: args.trusted ?? true,
    visible: args.visible ?? true,
    url: args.url ?? 'file:///app/index.html',
  } as FakeWindow;
  window.isVisible = () => window.visible;
  window.webContents = { getURL: () => window.url };
  return window;
}

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: () => harness.focused,
    getAllWindows: () => harness.windows,
  },
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  isTrustedAppRendererWindow: (window: FakeWindow | null) => Boolean(window?.trusted),
}));

vi.mock('../scheduleSlot.js', () => ({
  isMainShellWindowUrl: (url: string) => !url.includes('ghostPanelWindow='),
}));

import { resolveGhostProtocolDialogParent } from '../ghostProtocolDialogParent.js';

beforeEach(() => {
  harness.focused = null;
  harness.windows = [];
});

describe('resolveGhostProtocolDialogParent', () => {
  it('uses a focused trusted detached panel even when the main shell is hidden', () => {
    const panel = fakeWindow({ url: 'file:///app/index.html?ghostPanelWindow=art' });
    const hiddenMain = fakeWindow({ visible: false });
    harness.focused = panel;
    harness.windows = [hiddenMain, panel];

    expect(resolveGhostProtocolDialogParent()).toBe(panel);
  });

  it('does not attach a confirmation sheet to a hidden main shell', () => {
    harness.windows = [fakeWindow({ visible: false })];

    expect(resolveGhostProtocolDialogParent()).toBeNull();
  });

  it('falls back to a visible trusted main shell when focus is unavailable', () => {
    const visibleMain = fakeWindow();
    harness.windows = [fakeWindow({ trusted: false }), visibleMain];

    expect(resolveGhostProtocolDialogParent()).toBe(visibleMain);
  });
});
