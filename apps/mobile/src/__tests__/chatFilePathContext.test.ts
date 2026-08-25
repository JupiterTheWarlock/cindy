import { describe, expect, it } from 'vitest';

import {
  chatFileDirectAbsFallback,
  chatFilePreviewPathParams,
  shouldFetchChatFileByAbsolutePath,
  type ChatFilePathTarget,
} from '@/session/chatFilePathContext';

function fileTarget(relPath: string | null): ChatFilePathTarget {
  return {
    kind: 'file',
    relPath,
    absPath: 'D:\\repo\\tmp\\preview.png',
  };
}

describe('shouldFetchChatFileByAbsolutePath', () => {
  it('本地设备任务允许用绝对路径作为单文件取件兜底', () => {
    expect(shouldFetchChatFileByAbsolutePath(fileTarget('tmp/preview.png'))).toBe(true);
    expect(shouldFetchChatFileByAbsolutePath(fileTarget(null), '  ')).toBe(true);
  });

  it('SSH 任务不把远端绝对路径交给 Desktop 本机取件', () => {
    expect(shouldFetchChatFileByAbsolutePath(fileTarget('tmp/preview.png'), 'host-1')).toBe(false);
    expect(shouldFetchChatFileByAbsolutePath(fileTarget(null), 'host-1')).toBe(false);
  });

  it('目录不进入单文件绝对路径取件', () => {
    expect(shouldFetchChatFileByAbsolutePath({
      kind: 'directory',
      relPath: 'tmp',
      absPath: 'D:\\repo\\tmp',
    })).toBe(false);
  });
});

describe('chatFileDirectAbsFallback', () => {
  it('只有消息最初点名的文件使用绝对路径兜底，同目录翻页文件不继承', () => {
    expect(chatFileDirectAbsFallback(
      'tmp/preview.png',
      'D:\\repo\\tmp\\preview.png',
      'tmp/preview.png',
    )).toBe('D:\\repo\\tmp\\preview.png');
    expect(chatFileDirectAbsFallback(
      'tmp/preview.png',
      'D:\\repo\\tmp\\preview.png',
      'tmp/sibling.png',
    )).toBeNull();
  });
});

describe('chatFilePreviewPathParams', () => {
  it('本地设备任务保留 relPath 翻页并携带 directAbsPath 兜底', () => {
    expect(chatFilePreviewPathParams(fileTarget('tmp/preview.png'))).toEqual({
      relPath: 'tmp/preview.png',
      directAbsPath: 'D:\\repo\\tmp\\preview.png',
    });
  });

  it('SSH workdir 内文件只携带相对路径', () => {
    expect(chatFilePreviewPathParams(fileTarget('tmp/preview.png'), 'host-1')).toEqual({
      relPath: 'tmp/preview.png',
    });
  });

  it('既有 workdir 外文件继续进入 absPath 单文件模式', () => {
    expect(chatFilePreviewPathParams(fileTarget(null))).toEqual({
      absPath: 'D:\\repo\\tmp\\preview.png',
    });
  });

  it('SSH workdir 外文件 fail-closed，不回落到 Desktop 本机绝对路径', () => {
    expect(chatFilePreviewPathParams(fileTarget(null), 'host-1')).toBeNull();
  });
});
