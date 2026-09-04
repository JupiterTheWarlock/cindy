import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-model-context-limit-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tempRoot) },
}));

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'test-owner', generation: 1 }),
  ownerScopedUserDataPath: (...parts: string[]) => path.join(tempRoot, ...parts),
}));

import {
  __testing,
  applyModelContextLimit,
  isModelContextLimitCustomized,
  modelContextLimitKey,
  readModelContextLimit,
  readModelContextLimits,
  resetModelContextLimits,
  writeModelContextLimit,
} from '../model-context-limit-store';

const PREFS = path.join(tempRoot, 'model-context-limit-prefs.json');

function writeRawPrefs(value: unknown): void {
  fs.writeFileSync(PREFS, JSON.stringify(value), 'utf-8');
  __testing.invalidate();
}

describe('model context limit store', () => {
  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    if (fs.existsSync(PREFS)) fs.unlinkSync(PREFS);
    __testing.invalidate();
  });

  it('未设置时不落盘、不视为自定义', () => {
    expect(readModelContextLimit('claude-code', 'anthropic', 'claude-opus-5')).toBeNull();
    expect(isModelContextLimitCustomized('claude-code', 'anthropic', 'claude-opus-5')).toBe(false);
    expect(fs.existsSync(PREFS)).toBe(false);
  });

  it('写入后只存 override 条目，不快照默认值', () => {
    writeModelContextLimit('claude-code', 'anthropic', 'claude-opus-5', 500_000);
    expect(readModelContextLimit('claude-code', 'anthropic', 'claude-opus-5')).toBe(500_000);
    expect(isModelContextLimitCustomized('claude-code', 'anthropic', 'claude-opus-5')).toBe(true);
    const raw: unknown = JSON.parse(fs.readFileSync(PREFS, 'utf-8'));
    expect(raw).toEqual({
      limits: { [modelContextLimitKey('claude-code', 'anthropic', 'claude-opus-5')]: 500_000 },
    });
  });

  it('键含 agent：同一模型在不同引擎下互不影响', () => {
    writeModelContextLimit('claude-code', 'xd', 'gpt-5.6-sol', 500_000);
    expect(readModelContextLimit('codex', 'xd', 'gpt-5.6-sol')).toBeNull();
    writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 272_000);
    expect(readModelContextLimit('claude-code', 'xd', 'gpt-5.6-sol')).toBe(500_000);
    expect(readModelContextLimit('codex', 'xd', 'gpt-5.6-sol')).toBe(272_000);
  });

  it('写 null = 恢复默认：删条目而不是写一个默认值快照', () => {
    writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 272_000);
    expect(writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', null)).toBeNull();
    expect(isModelContextLimitCustomized('codex', 'xd', 'gpt-5.6-sol')).toBe(false);
    // 最后一个条目被删掉后整份 override 文件应当消失（= 完全跟随默认）。
    expect(fs.existsSync(PREFS)).toBe(false);
  });

  it('删掉一个条目不影响其它条目', () => {
    writeModelContextLimit('codex', 'xd', 'a', 100_000);
    writeModelContextLimit('codex', 'xd', 'b', 200_000);
    writeModelContextLimit('codex', 'xd', 'a', null);
    expect(readModelContextLimit('codex', 'xd', 'a')).toBeNull();
    expect(readModelContextLimit('codex', 'xd', 'b')).toBe(200_000);
  });

  it('低于下限的值不落盘（会让压缩在第一条消息就触发）', () => {
    writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 10);
    expect(readModelContextLimit('codex', 'xd', 'gpt-5.6-sol')).toBeNull();
    expect(fs.existsSync(PREFS)).toBe(false);
  });

  it('小数取整、荒谬量级收敛到上限', () => {
    writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 272_000.6);
    expect(readModelContextLimit('codex', 'xd', 'gpt-5.6-sol')).toBe(272_001);
    writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 1e12);
    expect(readModelContextLimit('codex', 'xd', 'gpt-5.6-sol')).toBe(__testing.MAX_LIMIT_TOKENS);
  });

  it('不 clamp 到模型窗口：路由配错时用户能强行往上填', () => {
    // 上游窗口 272K，用户填 1M —— 必须原样存下来（UI 侧给警示，不在这里拦）。
    writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 1_024_000);
    expect(readModelContextLimit('codex', 'xd', 'gpt-5.6-sol')).toBe(1_024_000);
    expect(applyModelContextLimit(272_000, 'codex', 'xd', 'gpt-5.6-sol')).toBe(272_000);
  });

  it('手改文件后下一次读取生效（隐藏配置也是正式契约）', () => {
    writeRawPrefs({ limits: { [modelContextLimitKey('codex', 'xd', 'm')]: 300_000 } });
    expect(readModelContextLimit('codex', 'xd', 'm')).toBe(300_000);
  });

  it('文件里的坏条目被丢弃 = 跟随默认，不污染同文件其它条目', () => {
    writeRawPrefs({
      limits: {
        [modelContextLimitKey('codex', 'xd', 'ok')]: 300_000,
        [modelContextLimitKey('codex', 'xd', 'nan')]: 'not-a-number',
        [modelContextLimitKey('codex', 'xd', 'zero')]: 0,
        [modelContextLimitKey('codex', 'xd', 'negative')]: -5,
        '': 400_000,
      },
    });
    expect(readModelContextLimit('codex', 'xd', 'ok')).toBe(300_000);
    expect(readModelContextLimit('codex', 'xd', 'nan')).toBeNull();
    expect(readModelContextLimit('codex', 'xd', 'zero')).toBeNull();
    expect(readModelContextLimit('codex', 'xd', 'negative')).toBeNull();
    expect(Object.keys(readModelContextLimits())).toHaveLength(1);
  });

  it('整体 reset 清空全部 override', () => {
    writeModelContextLimit('codex', 'xd', 'a', 100_000);
    writeModelContextLimit('claude-code', 'anthropic', 'b', 200_000);
    resetModelContextLimits();
    expect(readModelContextLimits()).toEqual({});
    expect(fs.existsSync(PREFS)).toBe(false);
  });
});

/**
 * 这一组是本轮唯一会改变现有运行时行为的点，必须锁死：**没有 override 的用户，
 * 窗口值逐位不变**。否则所有未自定义用户的压缩时机都会被静默改掉。
 */
describe('applyModelContextLimit：未自定义用户行为不变', () => {
  beforeEach(() => {
    if (fs.existsSync(PREFS)) fs.unlinkSync(PREFS);
    __testing.invalidate();
  });

  it('无 override 时原样返回上游窗口', () => {
    for (const window of [200_000, 272_000, 1_000_000, 1_048_576, 1_050_000]) {
      expect(applyModelContextLimit(window, 'codex', 'xd', 'gpt-5.6-sol')).toBe(window);
    }
  });

  it('有 override 时取两者更小值', () => {
    writeModelContextLimit('claude-code', 'anthropic', 'claude-opus-5', 500_000);
    expect(applyModelContextLimit(1_000_000, 'claude-code', 'anthropic', 'claude-opus-5')).toBe(
      500_000,
    );
    // 上限比窗口大时不放大窗口 —— 只能收紧，不能凭 override 声称模型能装更多。
    expect(applyModelContextLimit(200_000, 'claude-code', 'anthropic', 'claude-opus-5')).toBe(
      200_000,
    );
  });

  it('override 属于另一个引擎时不生效', () => {
    writeModelContextLimit('claude-code', 'anthropic', 'claude-opus-5', 500_000);
    expect(applyModelContextLimit(1_000_000, 'codex', 'anthropic', 'claude-opus-5')).toBe(
      1_000_000,
    );
  });

  it('目标信息不全或窗口本身不可用时原样返回，不拿上限顶替', () => {
    writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 100_000);
    expect(applyModelContextLimit(1_000_000, null, 'xd', 'gpt-5.6-sol')).toBe(1_000_000);
    expect(applyModelContextLimit(1_000_000, 'codex', null, 'gpt-5.6-sol')).toBe(1_000_000);
    expect(applyModelContextLimit(1_000_000, 'codex', 'xd', null)).toBe(1_000_000);
    expect(applyModelContextLimit(0, 'codex', 'xd', 'gpt-5.6-sol')).toBe(0);
    expect(applyModelContextLimit(-1, 'codex', 'xd', 'gpt-5.6-sol')).toBe(-1);
    expect(applyModelContextLimit(Number.NaN, 'codex', 'xd', 'gpt-5.6-sol')).toBeNaN();
  });
});
