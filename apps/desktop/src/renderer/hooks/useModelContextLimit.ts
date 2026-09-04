import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';

import type { AgentKind } from '@cindy/model-providers';

import type { ModelContextLimitView } from '../../shared/modelContextLimit';
import type { ModelPriceOverrideTarget } from '../../shared/modelPriceOverride';

const log = createLogger('UseModelContextLimit');

/**
 * 输入框边打字边写盘会把每个按键都变成一次 IPC + 落盘。300ms 与
 * `useCompactionSettings` 同口径。
 */
const WRITE_DEBOUNCE_MS = 300;

export interface ModelContextLimitState {
  /** 用户设定的上限（token 数）；null = 跟随路由窗口。加载完成前也是 null。 */
  limit: number | null;
  isCustomized: boolean;
  /** 首次读取尚未回来 —— 输入框在此期间不该显示成「未自定义」而闪一下。 */
  loading: boolean;
  /** 就地设值（debounce 落盘）。传 null 立即恢复默认。 */
  setLimit: (next: number | null) => void;
  /** 恢复默认（删 override）。 */
  reset: () => Promise<void>;
}

/**
 * 单模型上下文上限的读写。main 侧是唯一真源（`model-context-limit-store`），
 * 这里不缓存副本：写入返回落盘后的有效值，直接用它更新，避免「UI 显示的和实际生效的」
 * 分叉。
 *
 * target 为 null（未选中模型 / 抽屉关着）时 hook 空转，不发 IPC。
 */
export function useModelContextLimit(
  target: { providerId: string; agent: AgentKind; modelId: string } | null,
): ModelContextLimitState {
  const key = target ? `${target.agent}:${target.providerId}:${target.modelId}` : null;
  // 依赖用扁平 key 而不是对象：调用方多半在渲染里现构造 target 字面量，
  // 用对象做依赖会每帧重新发 IPC。
  const stableTarget = useMemo<ModelPriceOverrideTarget | null>(
    () =>
      target
        ? { providerId: target.providerId, agent: target.agent, modelId: target.modelId }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key 是 target 三元组的完整投影
    [key],
  );

  const [limit, setLimitState] = useState<number | null>(null);
  const [isCustomized, setIsCustomized] = useState(false);
  const [loading, setLoading] = useState(stableTarget !== null);
  const mountedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ target: ModelPriceOverrideTarget; limit: number | null } | null>(
    null,
  );

  const apply = useCallback((view: ModelContextLimitView) => {
    if (!mountedRef.current) return;
    setLimitState(view.limit);
    setIsCustomized(view.isCustomized);
  }, []);

  const reload = useCallback(async () => {
    if (!stableTarget) {
      setLimitState(null);
      setIsCustomized(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      apply(await window.electronAPI.maker.getModelContextLimit(stableTarget));
    } catch (err) {
      log.warn('getModelContextLimit failed', err);
      if (mountedRef.current) {
        setLimitState(null);
        setIsCustomized(false);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [apply, stableTarget]);

  const commit = useCallback(
    async (t: ModelPriceOverrideTarget, next: number | null) => {
      try {
        apply(await window.electronAPI.maker.setModelContextLimit(t, next));
      } catch (err) {
        // 写失败要回到磁盘真值,不能让 UI 停在一个没落盘的乐观值上。
        log.warn('setModelContextLimit failed', err);
        await reload();
      }
    },
    [apply, reload],
  );

  const flushPending = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    return pending;
  }, []);

  const setLimit = useCallback(
    (next: number | null) => {
      if (!stableTarget) return;
      setLimitState(next);
      setIsCustomized(next !== null);
      if (next === null) {
        // 恢复默认是个明确动作,不 debounce —— 用户点了「恢复默认」就该立刻生效。
        flushPending();
        void commit(stableTarget, null);
        return;
      }
      pendingRef.current = { target: stableTarget, limit: next };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (pending) void commit(pending.target, pending.limit);
      }, WRITE_DEBOUNCE_MS);
    },
    [commit, flushPending, stableTarget],
  );

  const reset = useCallback(async () => {
    if (!stableTarget) return;
    flushPending();
    try {
      apply(await window.electronAPI.maker.resetModelContextLimit(stableTarget));
    } catch (err) {
      log.warn('resetModelContextLimit failed', err);
      await reload();
    }
  }, [apply, flushPending, reload, stableTarget]);

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    return () => {
      mountedRef.current = false;
      // 卸载(关抽屉 / 切模型)时把 debounce 中的值补落盘 —— 用户填完就关抽屉是常见操作,
      // 丢掉这次输入会让人以为「设了但没生效」。
      const pending = flushPending();
      if (pending)
        void window.electronAPI.maker.setModelContextLimit(pending.target, pending.limit);
    };
  }, [flushPending, reload]);

  return { limit, isCustomized, loading, setLimit, reset };
}
