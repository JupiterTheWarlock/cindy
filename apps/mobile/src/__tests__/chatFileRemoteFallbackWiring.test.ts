import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relPath: string): string {
  return readFileSync(resolve(process.cwd(), relPath), 'utf8').replace(/\r\n/g, '\n');
}

const sessionSource = readSource('app/sessions/[sessionId].tsx');
const previewSource = readSource('app/files/preview/[sessionId].tsx');

describe('chat file remote workdir fallback wiring', () => {
  it('打开消息文件时同时传相对路径与受控绝对路径兜底', () => {
    expect(sessionSource).toContain('const pathParams = chatFilePreviewPathParams(target, currentSession?.remoteHostId)');
    expect(sessionSource).toContain('if (!pathParams) return;');
    expect(sessionSource).toContain('...pathParams,');
    expect(previewSource).toContain('directAbsPath?: string;');
    expect(previewSource).toContain('readRouteString(params.directAbsPath)');
  });

  it('图片、PDF、音视频和下载只在导出启动前的 workdir 错误上回退', () => {
    expect(previewSource).toContain('onRemoteWorkdirUnavailableAtStart: () => fetchRemoteAbsFileToUrl(');
    expect(previewSource).toContain('chatFileDirectAbsFallback(initialRelPath, directAbsPath, relPath)');
  });

  it('文本预览只在同一错误码下改走绝对路径读取', () => {
    expect(previewSource).toContain('!isRemoteWorkdirUnavailableError(error)');
    expect(previewSource).toContain('maker.fs.readTextFilePreview(fallbackAbsPath)');
  });

  it('消息文件分享复用同一导出启动兜底，SSH 不启用本机绝对路径兜底', () => {
    expect(sessionSource).toContain('shouldFetchChatFileByAbsolutePath(target, currentSession?.remoteHostId)');
    expect(sessionSource).toContain('onRemoteWorkdirUnavailableAtStart: () => fetchRemoteAbsFileToUrl(');
  });
});
