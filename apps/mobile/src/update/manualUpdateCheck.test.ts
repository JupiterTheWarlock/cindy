import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { storage.delete(key); }),
  },
}));

import { i18n } from '@/i18n';
import {
  __testing as analyticsConsentTesting,
  getAnalyticsConsentState,
  hydrateAnalyticsConsent,
} from '@/analytics/analyticsConsentStore';
import {
  manualUpdateCheckMessage,
  runManualUpdateCheck,
  type BundleUpdateCheckOutcome,
  type ManualUpdateCheckDeps,
} from './manualUpdateCheck';
import {
  __testing as canaryChannelTesting,
  EAS_CLIENT_ID_HEADER,
  SHARED_OTA_CLIENT_ID,
  hydrateCanaryChannel,
  resolveUpdateChannelForDevice,
  updateChannelRequestHeaders,
} from './canaryChannelStore';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

beforeEach(async () => {
  storage.clear();
  await Promise.all([
    analyticsConsentTesting.resetMemory(),
    canaryChannelTesting.resetMemory(),
  ]);
  vi.clearAllMocks();
});

/** 创建保留字面量结果类型的整包检查 mock。 */
const bundleCheck = (outcome: BundleUpdateCheckOutcome) =>
  vi.fn(async (): Promise<BundleUpdateCheckOutcome> => outcome);

/** 构造统一更新检查依赖,单测只覆写当前场景关心的能力。 */
function deps(overrides: Partial<ManualUpdateCheckDeps> = {}): ManualUpdateCheckDeps {
  return {
    otaEnabled: true,
    checkOtaUpdate: vi.fn(async () => ({ isAvailable: false })),
    fetchOtaUpdate: vi.fn(async () => ({ isNew: true })),
    reload: vi.fn(async () => undefined),
    isEmergencyLaunch: vi.fn(() => false),
    onPhase: vi.fn(),
    ...overrides,
  };
}

describe('runManualUpdateCheck', () => {
  it('stops after finding a full-package update', async () => {
    const input = deps({
      checkBundleUpdate: bundleCheck('update-available'),
      checkOtaUpdate: vi.fn(async () => ({ isAvailable: true })),
    });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'bundle-update-available' });
    expect(input.checkBundleUpdate).toHaveBeenCalledOnce();
    expect(input.checkOtaUpdate).not.toHaveBeenCalled();
    expect(input.fetchOtaUpdate).not.toHaveBeenCalled();
  });

  it('checks and applies OTA only after the full package is current', async () => {
    const phases: string[] = [];
    const input = deps({
      checkBundleUpdate: bundleCheck('up-to-date'),
      checkOtaUpdate: vi.fn(async () => ({ isAvailable: true })),
      onPhase: vi.fn((phase) => phases.push(phase)),
    });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'reloading' });
    expect(phases).toEqual(['checking', 'downloading']);
    expect(input.checkBundleUpdate).toHaveBeenCalledOnce();
    expect(input.checkOtaUpdate).toHaveBeenCalledOnce();
    expect(input.fetchOtaUpdate).toHaveBeenCalledOnce();
    expect(input.reload).toHaveBeenCalledOnce();
  });

  it('reports current only after both update channels have no update', async () => {
    const input = deps({ checkBundleUpdate: bundleCheck('up-to-date') });
    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'up-to-date' });
    expect(input.checkOtaUpdate).toHaveBeenCalledOnce();
  });

  it('does not hide a failed full-package check by continuing to OTA', async () => {
    const input = deps({ checkBundleUpdate: bundleCheck('error') });
    await expect(runManualUpdateCheck(input)).resolves.toEqual({
      kind: 'error',
      reason: 'bundle-check',
    });
    expect(input.checkOtaUpdate).not.toHaveBeenCalled();
  });

  it('keeps OTA checks available when the caller disables full-package checks', async () => {
    const input = deps();
    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'up-to-date' });
    expect(input.checkOtaUpdate).toHaveBeenCalledOnce();
  });

  it('returns an explicit result when OTA is unavailable after the full-package check', async () => {
    const input = deps({
      checkBundleUpdate: bundleCheck('up-to-date'),
      otaEnabled: false,
    });
    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'ota-unavailable' });
    expect(input.checkOtaUpdate).not.toHaveBeenCalled();
  });

  it('SSO + consent=false + Canary 仍使用共享 client id 检查并应用 OTA', async () => {
    // 企业 SSO 没有独立的本地登录类型标记；它的关键持久状态就是未同意统计，
    // 同时 feature-flags 已把 Canary 快照写为 true。用真实 store 还原该现场。
    storage.set(analyticsConsentTesting.storageKey, JSON.stringify({ consent: false }));
    storage.set(canaryChannelTesting.storageKey, 'true');
    await Promise.all([hydrateAnalyticsConsent(), hydrateCanaryChannel()]);

    expect(getAnalyticsConsentState().consent).toBe(false);
    const channel = resolveUpdateChannelForDevice();
    expect(channel).toBe('canary');
    const requestHeaders = updateChannelRequestHeaders(channel);
    const input = deps({
      checkBundleUpdate: bundleCheck('up-to-date'),
      checkOtaUpdate: vi.fn(async () => ({ isAvailable: true })),
    });

    expect(requestHeaders).toEqual({
      [EAS_CLIENT_ID_HEADER]: SHARED_OTA_CLIENT_ID,
      'x-cindy-update-channel': 'canary',
    });
    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'reloading' });
    expect(input.checkOtaUpdate).toHaveBeenCalledOnce();
    expect(input.fetchOtaUpdate).toHaveBeenCalledOnce();
    expect(input.reload).toHaveBeenCalledOnce();
    // OTA 不能借机伪造隐私同意或打开 TapDB。
    expect(getAnalyticsConsentState().consent).toBe(false);
    expect(storage.get(analyticsConsentTesting.storageKey)).toBe('{"consent":false}');
  });

  // emergency launch(没有 launchedUpdate)时 reloadAsync 会被原生层拒绝,但 bundle 已落盘:
  // 这不是一次失败的检查,必须导向"重开 App 生效",否则用户只看到一条无从下手的红字报错。
  it('asks for a manual restart when an emergency launch blocks reloading the downloaded bundle', async () => {
    const input = deps({
      checkOtaUpdate: vi.fn(async () => ({ isAvailable: true })),
      fetchOtaUpdate: vi.fn(async () => ({ isNew: true })),
      reload: vi.fn(async () => {
        throw new Error("Call to function 'ExpoUpdates.reload' has been rejected.");
      }),
      isEmergencyLaunch: vi.fn(() => true),
    });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({ kind: 'restart-required' });
    expect(input.fetchOtaUpdate).toHaveBeenCalledOnce();
    expect(input.reload).toHaveBeenCalledOnce();
  });

  it('still reports a failure when reload fails without any downloaded bundle', async () => {
    const input = deps({
      checkOtaUpdate: vi.fn(async () => ({ isAvailable: true })),
      fetchOtaUpdate: vi.fn(async () => ({ isNew: false })),
      reload: vi.fn(async () => {
        throw new Error('reload rejected');
      }),
      isEmergencyLaunch: vi.fn(() => true),
    });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({
      kind: 'error',
      reason: 'ota-check',
      detail: 'reload rejected',
    });
  });

  // 非应急启动下的 reload 失败原因未知,原始详情是唯一线索:不能被重启指引盖掉。
  it('keeps the reload failure detail when the app is not in an emergency launch', async () => {
    const input = deps({
      checkOtaUpdate: vi.fn(async () => ({ isAvailable: true })),
      fetchOtaUpdate: vi.fn(async () => ({ isNew: true })),
      reload: vi.fn(async () => {
        throw new Error('Could not reload application; activity is null');
      }),
      isEmergencyLaunch: vi.fn(() => false),
    });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({
      kind: 'error',
      reason: 'ota-check',
      detail: 'Could not reload application; activity is null',
    });
  });

  it('keeps OTA failure details unlocalized until the settings page renders them', async () => {
    const input = deps({
      checkOtaUpdate: vi.fn(async () => {
        throw new Error('offline');
      }),
    });

    await expect(runManualUpdateCheck(input)).resolves.toEqual({
      kind: 'error',
      reason: 'ota-check',
      detail: 'offline',
    });
  });
});

describe('manualUpdateCheckMessage', () => {
  it('tells the user to fully reopen the app when reload was rejected', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(manualUpdateCheckMessage({ kind: 'restart-required' }, { isTestFlightBuild: false, t: i18n.t }))
      .toBe('更新已下载，完全退出 App 后重新打开即可生效');
  });

  it('uses the current language for an already completed TestFlight check', async () => {
    const outcome = { kind: 'up-to-date' } as const;

    await i18n.changeLanguage('zh-CN');
    expect(manualUpdateCheckMessage(outcome, { isTestFlightBuild: true, t: i18n.t }))
      .toBe('当前没有可用的内容更新。新测试版本请在 TestFlight 中查看。');

    await i18n.changeLanguage('en');
    expect(manualUpdateCheckMessage(outcome, { isTestFlightBuild: true, t: i18n.t }))
      .toBe('No content updates are available. Check TestFlight for new test builds.');
  });
});
