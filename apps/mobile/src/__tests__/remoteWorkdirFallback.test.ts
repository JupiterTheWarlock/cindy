import { describe, expect, it } from 'vitest';

import { isRemoteWorkdirUnavailableError } from '@/session/remoteWorkdirFallback';

describe('isRemoteWorkdirUnavailableError', () => {
  it('识别结构化错误码', () => {
    expect(isRemoteWorkdirUnavailableError(
      Object.assign(new Error('Remote working directory check timed out.'), {
        code: 'REMOTE_WORKDIR_UNAVAILABLE',
      }),
    )).toBe(true);
  });

  it('兼容隧道展平后的错误文本', () => {
    expect(isRemoteWorkdirUnavailableError(
      '[REMOTE_WORKDIR_UNAVAILABLE] Remote working directory check timed out.',
    )).toBe(true);
  });

  it('不把普通超时或其它远程错误误判成路径兜底条件', () => {
    expect(isRemoteWorkdirUnavailableError(new Error('request timed out'))).toBe(false);
    expect(isRemoteWorkdirUnavailableError('[NOT_REMOTE_WORKDIR_UNAVAILABLE] wrong marker')).toBe(false);
    expect(isRemoteWorkdirUnavailableError(
      Object.assign(new Error('offline'), { code: 'DEVICE_OFFLINE' }),
    )).toBe(false);
  });
});
