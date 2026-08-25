/**
 * 远程文件两段式导出 → presign 下载地址(浏览页长按「导出/分享」与预览页
 * 分享/下载共用)。结果按 path+mtime 缓存到 presign 过期,同一文件重看零导出;
 * 起始与每次状态轮询都走瞬断重试;isCancelled(页面卸载)时中止轮询。
 */
import { i18n } from '@/i18n';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { getCachedExportUrl, storeCachedExportUrl } from '@/session/fileBrowserCache';
import type { MobileRemoteMediaPresignResult } from '@/session/remoteMedia';
import { isRemoteWorkdirUnavailableError } from '@/session/remoteWorkdirFallback';

const EXPORT_POLL_INTERVAL_MS = 700;
const EXPORT_TIMEOUT_MS = 120_000;

export interface ExportRemoteFileDeps {
  maker: {
    fileBrowser: Pick<
      MobileMakerTransport['fileBrowser'],
      'exportFileStart' | 'exportFileStatus'
    >;
  };
  deviceId: string;
  openLink: (deviceId: string) => Promise<unknown>;
  presignGet: (ossKey: string) => Promise<MobileRemoteMediaPresignResult>;
  /** 取消信号(如页面卸载):轮询每轮检查,true 即中止,不再空转最长 2 分钟。 */
  isCancelled?: () => boolean;
  /**
   * 仅在 exportFileStart 尚未创建导出任务、且 workdir 前置探测明确不可用时调用。
   * status 阶段不回退，避免遗留已启动的后台导出任务或 OSS 对象。
   */
  onRemoteWorkdirUnavailableAtStart?: () => Promise<string>;
}

export async function exportRemoteFileToUrl(
  deps: ExportRemoteFileDeps,
  workdir: string,
  relPath: string,
  mtimeMs: number,
): Promise<string> {
  const cached = getCachedExportUrl(deps.deviceId, workdir, relPath, mtimeMs);
  if (cached) return cached;
  let start: Awaited<ReturnType<MobileMakerTransport['fileBrowser']['exportFileStart']>>;
  try {
    start = await withTransientRemoteRetry(async () => {
      await deps.openLink(deps.deviceId);
      return deps.maker.fileBrowser.exportFileStart(workdir, relPath);
    });
  } catch (error) {
    if (deps.onRemoteWorkdirUnavailableAtStart && isRemoteWorkdirUnavailableError(error)) {
      return deps.onRemoteWorkdirUnavailableAtStart();
    }
    throw error;
  }
  if (!start.ok) throw new Error(start.message ?? i18n.t('files.export.exportFailed'));
  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  for (;;) {
    if (deps.isCancelled?.()) throw new Error(i18n.t('files.export.leftPage'));
    // 单次状态查询同样走瞬断重试:被控端导出任务仍在跑,轮询窗口内一次
    // 掉线/超时不应让整个导出失败。
    const status = await withTransientRemoteRetry(async () => {
      await deps.openLink(deps.deviceId);
      return deps.maker.fileBrowser.exportFileStatus(workdir, start.transferId);
    });
    if (!status.ok) throw new Error(status.message ?? i18n.t('files.export.exportFailed'));
    if (status.state === 'done' && status.key) {
      const presign = await deps.presignGet(status.key);
      storeCachedExportUrl(deps.deviceId, workdir, relPath, mtimeMs, presign.getUrl, presign.expiresAt);
      return presign.getUrl;
    }
    if (status.state === 'error') throw new Error(status.message ?? i18n.t('files.export.exportFailed'));
    if (Date.now() > deadline) throw new Error(i18n.t('files.export.exportTimeout'));
    await new Promise<void>((resolve) => setTimeout(resolve, EXPORT_POLL_INTERVAL_MS));
  }
}
