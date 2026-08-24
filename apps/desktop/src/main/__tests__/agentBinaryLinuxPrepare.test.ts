import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// getBase() 按 kind 缓存 provisioner 实例:全部测试共享同一个 cdndProvisioner,
// 每测试重配它的行为(而不是 mockReturnValueOnce 换实例——缓存会让新实例永远不被使用)。
const {
  appMock,
  cdndProvisioner,
  createBinaryProvisioner,
  findCachedLinuxRuntimeFallbackBinary,
  prepareLinuxRuntimeFallback,
} = vi.hoisted(() => {
  const cdndProvisioner = {
    prepare: vi.fn(),
    peekNeedsDownload: vi.fn(),
    getState: vi.fn(async () => ({ status: 'not_installed' })),
    cleanup: vi.fn(),
  };
  return {
    appMock: { isPackaged: true, getPath: vi.fn(() => '/tmp/xdt-userdata') },
    cdndProvisioner,
    createBinaryProvisioner: vi.fn(() => cdndProvisioner),
    findCachedLinuxRuntimeFallbackBinary: vi.fn((): string | null => null),
    prepareLinuxRuntimeFallback: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../agent-binaries/factory.js', () => ({ createBinaryProvisioner }));
vi.mock('../agent-binaries/dev-fallback.js', () => ({ findDevBinary: vi.fn(() => null) }));
vi.mock('../agent-binaries/linux-runtime-fallback.js', () => ({
  findCachedLinuxRuntimeFallbackBinary,
  prepareLinuxRuntimeFallback,
}));
// CDN manifest 缺省不可用(无缓存)。CDN 命中用例单独 stub getCachedManifest。
vi.mock('../manifestService.js', () => ({
  getPlatformKey: () => 'linux-x64',
  getCachedManifest: vi.fn((): unknown => null),
}));
vi.mock('../updateProgressNormalizer.js', () => ({
  ProgressNormalizer: class {
    handle(): void {}
    flush(): void {}
    getCurrent(): number { return 0; }
  },
}));

const originalPlatform = process.platform;
let binaries: typeof import('../agent-binaries/index');
let manifestService: { getCachedManifest: ReturnType<typeof vi.fn> };

beforeAll(async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  manifestService = (await import('../manifestService.js')) as never;
  binaries = await import('../agent-binaries/index');
});

beforeEach(() => {
  vi.clearAllMocks();
  appMock.isPackaged = true;
  // 默认:CDN 链失败(asset_missing)→ 回落 fallback;fallback 命中私有安装。
  cdndProvisioner.prepare.mockReset().mockResolvedValue({ ready: false, binaryPath: '', error: 'asset_missing' });
  cdndProvisioner.peekNeedsDownload.mockReset().mockResolvedValue(true);
  findCachedLinuxRuntimeFallbackBinary.mockReturnValue(null);
  prepareLinuxRuntimeFallback.mockResolvedValue({
    ready: true,
    binaryPath: '/tmp/xdt-userdata/agent-runtime/claude-code/bin/claude',
    installed: true,
    source: 'installed',
  });
});

describe('packaged Linux agent binary prepare', () => {
  it('keeps cached status fs-only and does not run runtime verification', () => {
    findCachedLinuxRuntimeFallbackBinary.mockReturnValue(
      '/tmp/xdt-userdata/agent-runtime/codex/codex-home/bin/codex',
    );

    expect(binaries.getCachedBinaryStatus('codex')).toEqual({
      binaryReady: true,
      binaryPath: '/tmp/xdt-userdata/agent-runtime/codex/codex-home/bin/codex',
    });
    expect(findCachedLinuxRuntimeFallbackBinary).toHaveBeenCalledWith('codex');
  });

  it('falls back to the runtime chain when the CDN chain reports asset_missing', async () => {
    prepareLinuxRuntimeFallback.mockResolvedValueOnce({
      ready: true,
      binaryPath: '/usr/local/bin/claude',
      installed: false,
      source: 'system',
    });

    const result = await binaries.prepare('claude-code');

    expect(result).toEqual({
      ready: true,
      path: '/usr/local/bin/claude',
      downloaded: false,
    });
    // CDN 链先试(manifest 无段 → asset_missing),失败后静默落到 fallback。
    expect(cdndProvisioner.prepare).toHaveBeenCalled();
    expect(prepareLinuxRuntimeFallback).toHaveBeenCalledWith('claude-code', {
      signal: undefined,
      onProgress: expect.any(Function),
    });
  });

  it('propagates signal and returns fallback install result when CDN misses', async () => {
    const controller = new AbortController();
    const result = await binaries.prepare('claude-code');

    expect(result).toEqual({
      ready: true,
      path: '/tmp/xdt-userdata/agent-runtime/claude-code/bin/claude',
      downloaded: true,
    });
    await binaries.prepare('codex', { signal: controller.signal });
    expect(prepareLinuxRuntimeFallback).toHaveBeenNthCalledWith(1, 'claude-code', {
      signal: undefined,
      onProgress: expect.any(Function),
    });
    expect(prepareLinuxRuntimeFallback).toHaveBeenNthCalledWith(2, 'codex', {
      signal: controller.signal,
      onProgress: expect.any(Function),
    });
  });

  it('prefers the CDN chain when the manifest publishes a linux asset, without touching the fallback', async () => {
    manifestService.getCachedManifest.mockReturnValue({
      app: { version: '0.1.59' },
      claudeCode: {
        version: '2.1.219',
        file: 'claude-code/2.1.219/linux-x64/claude.gz',
        sha256: 'a'.repeat(64),
        size: 1234,
      },
    });
    cdndProvisioner.prepare.mockResolvedValueOnce({
      ready: true,
      binaryPath: '/tmp/xdt-userdata/claude-code/2.1.219/claude',
    });

    const result = await binaries.prepare('claude-code');

    expect(result.ready).toBe(true);
    expect(result.path).toBe('/tmp/xdt-userdata/claude-code/2.1.219/claude');
    expect(prepareLinuxRuntimeFallback).not.toHaveBeenCalled();
  });

  it('survives a throwing CDN chain and still resolves via the fallback', async () => {
    cdndProvisioner.prepare.mockReset().mockRejectedValue(new Error('disk exploded'));

    const result = await binaries.prepare('claude-code');

    expect(result.ready).toBe(true);
    expect(result.path).toBe('/tmp/xdt-userdata/agent-runtime/claude-code/bin/claude');
    expect(prepareLinuxRuntimeFallback).toHaveBeenCalled();
  });

  it('peek reports a local miss as a need without fetching a manifest', async () => {
    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    expect(findCachedLinuxRuntimeFallbackBinary).toHaveBeenCalledWith('codex');
    expect(cdndProvisioner.peekNeedsDownload).not.toHaveBeenCalled();
  });

  it('peek delegates to the CDN check when the manifest publishes a linux asset', async () => {
    manifestService.getCachedManifest.mockReturnValue({
      app: { version: '0.1.59' },
      codex: {
        version: '0.144.6',
        file: 'codex/0.144.6/linux-x64/codex.gz',
        sha256: 'b'.repeat(64),
        size: 5678,
      },
    });

    await expect(binaries.peekNeedsDownload('codex')).resolves.toBe(true);
    expect(cdndProvisioner.peekNeedsDownload).toHaveBeenCalled();
    expect(findCachedLinuxRuntimeFallbackBinary).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});
