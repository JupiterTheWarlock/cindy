import { BrowserWindow } from 'electron';

import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { isMainShellWindowUrl } from './scheduleSlot.js';

/**
 * Native plugin confirmations must have a visible trusted parent on macOS so an
 * AbortSignal can close the sheet during an owner boundary.
 */
export function resolveGhostProtocolDialogParent(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (isTrustedAppRendererWindow(focused)) return focused;
  return (
    BrowserWindow.getAllWindows().find(
      (window) =>
        isTrustedAppRendererWindow(window) &&
        window.isVisible() &&
        isMainShellWindowUrl(window.webContents.getURL()),
    ) ?? null
  );
}
