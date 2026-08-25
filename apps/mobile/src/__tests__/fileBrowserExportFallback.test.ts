import { describe, expect, it, vi } from 'vitest';

import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import {
  exportRemoteFileToUrl,
  type ExportRemoteFileDeps,
} from '@/session/fileBrowserExport';

function makeDeps() {
  const exportFileStart = vi.fn<MobileMakerTransport['fileBrowser']['exportFileStart']>();
  const exportFileStatus = vi.fn<MobileMakerTransport['fileBrowser']['exportFileStatus']>();
  const fallback = vi.fn(async () => 'https://oss.example/direct');
  const deps: ExportRemoteFileDeps = {
    maker: {
      fileBrowser: {
        exportFileStart,
        exportFileStatus,
      },
    },
    deviceId: `dev-${Math.random().toString(36).slice(2)}`,
    openLink: vi.fn(async () => undefined),
    presignGet: vi.fn(async () => ({
      getUrl: 'https://oss.example/export',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })),
    onRemoteWorkdirUnavailableAtStart: fallback,
  };
  return { deps, exportFileStart, exportFileStatus, fallback };
}

describe('exportRemoteFileToUrl workdir fallback', () => {
  it('正常导出保留 start→status→presign 与 path+mtime 缓存，不调用兜底', async () => {
    const { deps, exportFileStart, exportFileStatus, fallback } = makeDeps();
    exportFileStart.mockResolvedValueOnce({ ok: true, transferId: 'transfer-ok', size: 2, mtimeMs: 9 });
    exportFileStatus.mockResolvedValueOnce({
      ok: true,
      state: 'done',
      key: 'exports/file-ok',
      size: 2,
      uploaded: 2,
    });

    await expect(exportRemoteFileToUrl(deps, 'D:\\repo', 'tmp/ok.png', 9))
      .resolves.toBe('https://oss.example/export');
    await expect(exportRemoteFileToUrl(deps, 'D:\\repo', 'tmp/ok.png', 9))
      .resolves.toBe('https://oss.example/export');
    expect(exportFileStart).toHaveBeenCalledTimes(1);
    expect(exportFileStatus).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('只在导出任务创建前的 workdir 不可用错误上回退', async () => {
    const { deps, exportFileStart, exportFileStatus, fallback } = makeDeps();
    exportFileStart.mockRejectedValueOnce(Object.assign(new Error('probe timed out'), {
      code: 'REMOTE_WORKDIR_UNAVAILABLE',
    }));

    await expect(exportRemoteFileToUrl(deps, 'D:\\repo', 'tmp/a.png', 1))
      .resolves.toBe('https://oss.example/direct');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(exportFileStatus).not.toHaveBeenCalled();
  });

  it('导出状态阶段失败不回退，避免遗留后台任务', async () => {
    const { deps, exportFileStart, exportFileStatus, fallback } = makeDeps();
    exportFileStart.mockResolvedValueOnce({ ok: true, transferId: 'transfer-1', size: 1, mtimeMs: 1 });
    exportFileStatus.mockRejectedValueOnce(Object.assign(new Error('probe timed out'), {
      code: 'REMOTE_WORKDIR_UNAVAILABLE',
    }));

    await expect(exportRemoteFileToUrl(deps, 'D:\\repo', 'tmp/b.png', 2))
      .rejects.toThrow('probe timed out');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('其它导出启动错误原样抛出', async () => {
    const { deps, exportFileStart, fallback } = makeDeps();
    exportFileStart.mockRejectedValueOnce(Object.assign(new Error('remote disabled'), {
      code: 'REMOTE_DISABLED',
    }));

    await expect(exportRemoteFileToUrl(deps, 'D:\\repo', 'tmp/c.png', 3))
      .rejects.toThrow('remote disabled');
    expect(fallback).not.toHaveBeenCalled();
  });
});
