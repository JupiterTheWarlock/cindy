/**
 * 只识别 Desktop 明确返回的远程工作目录不可用错误。
 *
 * 不能把任意超时、断链或导出失败都回退到绝对路径：调用方只有在确认失败发生于
 * workdir 前置探测时，才可以复用已经通过消息路径验证的单文件取件能力。
 */
export function isRemoteWorkdirUnavailableError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'REMOTE_WORKDIR_UNAVAILABLE') return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /(?:^|[^A-Z0-9_])REMOTE_WORKDIR_UNAVAILABLE(?:[^A-Z0-9_]|$)/.test(message);
}
