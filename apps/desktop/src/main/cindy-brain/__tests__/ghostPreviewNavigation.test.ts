import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { GhostPreviewOutcome } from '../previewGate';
import { runGhostPreviewNavigation } from '../ghostPreviewNavigation';

describe('runGhostPreviewNavigation', () => {
  it('owner 在账本查询期间切换后不向新 owner 的 renderer 推送旧预览', async () => {
    let ownerActive = true;
    let finishRequest!: (outcome: GhostPreviewOutcome) => void;
    const request = vi.fn(
      () =>
        new Promise<GhostPreviewOutcome>((resolve) => {
          finishRequest = resolve;
        }),
    );
    const send = vi.fn();
    const hostContents = { isDestroyed: () => false } as unknown as WebContents;
    const guestContents = {
      isDestroyed: () => false,
      isFocused: () => true,
    } as unknown as WebContents;

    const pending = runGhostPreviewNavigation(
      {
        ghostId: 'same-ghost',
        url: `cindy-ghost://same-ghost/preview/${'a'.repeat(64)}.png`,
        hostContents,
        guestContents,
      },
      {
        request,
        isOwnerActive: () => ownerActive,
        send,
        logger: { debug: vi.fn(), warn: vi.fn() },
      },
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    ownerActive = false;
    finishRequest({ ok: true, src: 'cindy-media://blob/owner-a.png', kind: 'image' });
    await pending;

    expect(send).not.toHaveBeenCalled();
  });
});
