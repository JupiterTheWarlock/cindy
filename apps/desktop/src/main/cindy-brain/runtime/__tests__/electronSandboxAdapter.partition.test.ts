import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const harness = vi.hoisted(() => {
  let nextWebContentsId = 1;
  type RegisteredSession = {
    permissionRequest: ReturnType<typeof vi.fn>;
    permissionCheck: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    beforeRequest: ReturnType<typeof vi.fn>;
    protocolHandle: ReturnType<typeof vi.fn>;
    beforeRequestHandler?: (
      details: { url: string },
      callback: (result: { cancel: boolean }) => void,
    ) => void;
    protocolHandler?: (request: Request) => Promise<Response>;
    downloadHandler?: (event: { preventDefault(): void }) => void;
  };
  const sessions = new Map<string, RegisteredSession>();
  return {
    activeOwner: {
      mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
      dataOwnerId: 'owner-a' as string | null,
      generation: 1,
    },
    boundaryPending: false,
    sessions,
    fromPartition: vi.fn((partition: string) => {
      const existing = sessions.get(partition);
      if (existing) return existing;
      const created: RegisteredSession = {
        permissionRequest: vi.fn(),
        permissionCheck: vi.fn(),
        on: vi.fn((event: string, handler: (event: { preventDefault(): void }) => void) => {
          if (event === 'will-download') created.downloadHandler = handler;
        }),
        beforeRequest: vi.fn((handler) => {
          created.beforeRequestHandler = handler;
        }),
        protocolHandle: vi.fn(
          (_scheme: string, handler: (request: Request) => Promise<Response>) => {
            created.protocolHandler = handler;
          },
        ),
      };
      sessions.set(partition, created);
      return {
        setPermissionRequestHandler: created.permissionRequest,
        setPermissionCheckHandler: created.permissionCheck,
        on: created.on,
        webRequest: { onBeforeRequest: created.beforeRequest },
        protocol: { handle: created.protocolHandle },
      };
    }),
    browserWindowOptions: [] as Array<Record<string, unknown>>,
    createReadStream: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn().mockResolvedValue({ isFile: () => true, size: 1024 }),
    BrowserWindow: vi.fn(function BrowserWindow(options: Record<string, unknown>) {
      harness.browserWindowOptions.push(options);
      const webContents = {
        id: nextWebContentsId++,
        on: vi.fn(),
        isDestroyed: vi.fn(() => false),
        forcefullyCrashRenderer: vi.fn(),
      };
      return {
        webContents,
        loadURL: vi.fn().mockResolvedValue(undefined),
        isDestroyed: vi.fn(() => false),
        destroy: vi.fn(),
      };
    }),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: harness.BrowserWindow,
  session: { fromPartition: harness.fromPartition },
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock('node:fs', () => ({
  createReadStream: harness.createReadStream,
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: harness.readFile,
    stat: harness.stat,
  },
}));

vi.mock('../../../appSessionState', () => ({
  dataOwnerStorageKey: (ownerId: string) => `opaque-${ownerId}`,
  getActiveAppSession: () => ({ ...harness.activeOwner }),
  isAppSessionBoundaryPending: () => harness.boundaryPending,
}));

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../cindy-media/blobStore', () => ({
  readBlob: vi.fn(),
  resolveHashRef: vi.fn(),
}));

vi.mock('../../../cindy-media/ledger', () => ({
  ghostCanRead: vi.fn(),
  listGhostGallery: vi.fn().mockResolvedValue([]),
}));

import type { InstalledGhost } from '../../../../shared/ghost';
import {
  electronSandboxAdapter,
  abortGhostProtocolRequestsForAccountBoundary,
  ensureGhostProtocolRegistered,
  setGhostConnectionsHandler,
  setGhostLibraryFileResolver,
  setGhostKvStore,
  waitForGhostProtocolRequests,
} from '../electronSandboxAdapter';

function ghost(id: string): InstalledGhost {
  return {
    dir: `/plugins/${id}`,
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['panel'],
      panel: { html: 'panel.html' },
    },
  };
}

beforeEach(() => {
  harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-a', generation: 1 };
  harness.boundaryPending = false;
  harness.fromPartition.mockClear();
  harness.BrowserWindow.mockClear();
  harness.browserWindowOptions.length = 0;
  harness.createReadStream.mockReset();
  harness.readFile.mockReset();
  setGhostLibraryFileResolver(null);
});

describe('electronSandboxAdapter owner partition', () => {
  it('同 ghostId 的不同 owner 注册不同 session，且每个 session 都显式拒绝权限和下载', () => {
    const installed = ghost('same-ghost');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-b',
      generation: 2,
    });

    const partitionA = 'cindy-ghost-owner:cloud:opaque-owner-a:same-ghost';
    const partitionB = 'cindy-ghost-owner:cloud:opaque-owner-b:same-ghost';
    const sessionA = harness.sessions.get(partitionA);
    const sessionB = harness.sessions.get(partitionB);
    expect(sessionA).toBeDefined();
    expect(sessionB).toBeDefined();

    for (const registered of [sessionA, sessionB]) {
      expect(registered?.permissionRequest).toHaveBeenCalledOnce();
      expect(registered?.permissionCheck).toHaveBeenCalledOnce();
      expect(registered?.on).toHaveBeenCalledWith('will-download', expect.any(Function));

      const permissionCallback = vi.fn();
      registered?.permissionRequest.mock.calls[0]?.[0](null, 'camera', permissionCallback);
      expect(permissionCallback).toHaveBeenCalledWith(false);
      expect(registered?.permissionCheck.mock.calls[0]?.[0]()).toBe(false);

      const downloadEvent = { preventDefault: vi.fn() };
      registered?.downloadHandler?.(downloadEvent);
      expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it('协议和网络 handler 在 owner 变化或切换边界中 fail closed', async () => {
    const installed = ghost('owner-fence');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    const registered = harness.sessions.get('cindy-ghost-owner:cloud:opaque-owner-a:owner-fence');
    expect(registered?.protocolHandler).toBeDefined();
    expect(registered?.beforeRequestHandler).toBeDefined();

    harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
    const response = await registered?.protocolHandler?.(
      new Request('cindy-ghost://owner-fence/panel.html'),
    );
    expect(response?.status).toBe(403);

    const networkResult = vi.fn();
    registered?.beforeRequestHandler?.(
      { url: 'cindy-ghost://owner-fence/panel.html' },
      networkResult,
    );
    expect(networkResult).toHaveBeenCalledWith({ cancel: true });

    harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-a', generation: 1 };
    harness.boundaryPending = true;
    const boundaryResponse = await registered?.protocolHandler?.(
      new Request('cindy-ghost://owner-fence/panel.html'),
    );
    expect(boundaryResponse?.status).toBe(403);
  });

  it('同 owner generation 变化后既有 WebView 无需重新 attach 仍可访问', async () => {
    const installed = ghost('generation-refresh');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    harness.activeOwner.generation = 2;

    const registered = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-a:generation-refresh',
    );
    const response = await registered?.protocolHandler?.(
      new Request('cindy-ghost://generation-refresh/'),
    );
    expect(response?.status).toBe(200);
  });

  it('边界会等待已入闸的 KV 请求在旧 owner 下完成，再允许提交新 owner', async () => {
    const installed = ghost('inflight-kv');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    const writes: string[] = [];
    setGhostKvStore({
      read: () => ({}),
      write: () => {
        writes.push(`${harness.activeOwner.dataOwnerId}:${harness.activeOwner.generation}`);
      },
    });

    let resolveFirstRead!: (value: { done: false; value: Uint8Array }) => void;
    let readCount = 0;
    const read = vi.fn(() => {
      if (readCount++ === 0) {
        return new Promise<{ done: false; value: Uint8Array }>((resolve) => {
          resolveFirstRead = resolve;
        });
      }
      return Promise.resolve({ done: true as const });
    });
    const request = {
      url: 'cindy-ghost://inflight-kv/kv',
      method: 'PUT',
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel: vi.fn().mockResolvedValue(undefined) }) },
    } as unknown as Request;
    const registered = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-a:inflight-kv',
    );
    const responsePromise = registered!.protocolHandler!(request);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());

    harness.boundaryPending = true;
    let drained = false;
    const drainPromise = waitForGhostProtocolRequests().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveFirstRead({
      done: false,
      value: new TextEncoder().encode('{"owner":"a"}'),
    });
    expect((await responsePromise).status).toBe(204);
    await drainPromise;
    expect(writes).toEqual(['owner-a:1']);

    harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
  });

  it('请求体等待期间 owner 若意外变化，旧请求按 403 收口且不写新 owner', async () => {
    const installed = ghost('stale-kv');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    const write = vi.fn();
    setGhostKvStore({ read: () => ({}), write });

    let resolveFirstRead!: (value: { done: false; value: Uint8Array }) => void;
    let readCount = 0;
    const read = vi.fn(() => {
      if (readCount++ === 0) {
        return new Promise<{ done: false; value: Uint8Array }>((resolve) => {
          resolveFirstRead = resolve;
        });
      }
      return Promise.resolve({ done: true as const });
    });
    const request = {
      url: 'cindy-ghost://stale-kv/kv',
      method: 'PUT',
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel: vi.fn().mockResolvedValue(undefined) }) },
    } as unknown as Request;
    const registered = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-a:stale-kv',
    );
    const responsePromise = registered!.protocolHandler!(request);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());

    harness.activeOwner = { mode: 'cloud', dataOwnerId: 'owner-b', generation: 2 };
    resolveFirstRead({
      done: false,
      value: new TextEncoder().encode('{"owner":"stale"}'),
    });

    expect((await responsePromise).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
    await waitForGhostProtocolRequests();
  });

  it('账号边界会取消永不结束的请求体，drain 不被插件阻塞', async () => {
    const installed = ghost('hanging-kv');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    const write = vi.fn();
    setGhostKvStore({ read: () => ({}), write });

    const cancel = vi.fn(() => new Promise<never>(() => {}));
    const read = vi.fn(() => new Promise<never>(() => {}));
    const request = {
      url: 'cindy-ghost://hanging-kv/kv',
      method: 'PUT',
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Request;
    const registered = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-a:hanging-kv',
    );
    const responsePromise = registered!.protocolHandler!(request);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());

    harness.boundaryPending = true;
    abortGhostProtocolRequestsForAccountBoundary();

    expect((await responsePromise).status).toBe(403);
    await waitForGhostProtocolRequests();
    expect(cancel).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('Response 已返回但未读完的 library 流会在账号边界被销毁', async () => {
    const installed = ghost('streaming-library');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    setGhostLibraryFileResolver(async () => '/owner-a/library/video.mp4');
    const stream = new Readable({ read: () => {} });
    const destroy = vi.spyOn(stream, 'destroy');
    harness.createReadStream.mockReturnValue(stream);

    const registered = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-a:streaming-library',
    );
    const response = await registered!.protocolHandler!(
      new Request('cindy-ghost://streaming-library/library/video.mp4'),
    );
    expect(response.status).toBe(200);
    expect(destroy).not.toHaveBeenCalled();

    harness.boundaryPending = true;
    abortGhostProtocolRequestsForAccountBoundary();

    expect(destroy).toHaveBeenCalledOnce();
  });

  it('library resolver 等待期间开始边界，恢复后不会再创建漏网文件流', async () => {
    const installed = ghost('pending-library');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    let resolveLibrary!: (path: string) => void;
    const resolver = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLibrary = resolve;
        }),
    );
    setGhostLibraryFileResolver(resolver);
    const registered = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-a:pending-library',
    );
    const responsePromise = registered!.protocolHandler!(
      new Request('cindy-ghost://pending-library/library/video.mp4'),
    );
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());

    harness.boundaryPending = true;
    abortGhostProtocolRequestsForAccountBoundary();
    resolveLibrary('/owner-a/library/video.mp4');

    expect((await responsePromise).status).toBe(403);
    expect(harness.createReadStream).not.toHaveBeenCalled();
    await waitForGhostProtocolRequests();
  });

  it('静态插件文件读取被账号边界取消时按 403 收口', async () => {
    const installed = ghost('pending-static');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    harness.readFile.mockImplementation(
      (_path: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    );
    const registered = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-a:pending-static',
    );
    const responsePromise = registered!.protocolHandler!(
      new Request('cindy-ghost://pending-static/panel.html'),
    );
    await vi.waitFor(() => expect(harness.readFile).toHaveBeenCalledOnce());

    harness.boundaryPending = true;
    abortGhostProtocolRequestsForAccountBoundary();

    expect((await responsePromise).status).toBe(403);
    await waitForGhostProtocolRequests();
  });

  it('账号边界把取消信号传给等待主机确认的协议 handler', async () => {
    const installed = ghost('pending-confirmation');
    ensureGhostProtocolRegistered(installed, {
      mode: 'cloud',
      dataOwnerId: 'owner-a',
      generation: 1,
    });
    const observedAbort = vi.fn();
    setGhostConnectionsHandler(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              observedAbort();
              resolve({ status: 200 });
            },
            { once: true },
          );
        }),
    );

    const registered = harness.sessions.get(
      'cindy-ghost-owner:cloud:opaque-owner-a:pending-confirmation',
    );
    const responsePromise = registered!.protocolHandler!(
      new Request('cindy-ghost://pending-confirmation/connections'),
    );
    harness.boundaryPending = true;
    abortGhostProtocolRequestsForAccountBoundary();

    expect((await responsePromise).status).toBe(403);
    expect(observedAbort).toHaveBeenCalledOnce();
    await waitForGhostProtocolRequests();
  });

  it('隐藏逻辑页使用与可见 WebView 相同的 owner-scoped partition', () => {
    const handle = electronSandboxAdapter.create(ghost('logic-page'));

    expect(harness.browserWindowOptions[0]).toMatchObject({
      webPreferences: {
        partition: 'cindy-ghost-owner:cloud:opaque-owner-a:logic-page',
      },
    });
    handle.destroy();
  });
});
