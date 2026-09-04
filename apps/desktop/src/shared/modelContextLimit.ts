/**
 * 单模型上下文上限 override 的跨进程形状。
 *
 * 目标三元组复用 `modelPriceOverride` 的 `ModelPriceOverrideTarget`
 * （providerId × agent × modelId）—— 两者是同一粒度的设置类 override，
 * 再定义一份同形类型只会让 IPC 两侧各自漂。
 *
 * 语义与存储见 main 侧 `maker-host/model-context-limit-store.ts` 头注。
 */

export interface ModelContextLimitView {
  /** 用户设定的上限（token 数）；null = 跟随路由窗口。 */
  limit: number | null;
  /**
   * 是否被用户显式设过。与 `limit !== null` 不等价的意义在于：UI 要能区分
   * 「跟随默认」和「设了一个刚好等于默认的值」——后者在上游改窗口后不该被静默带走。
   */
  isCustomized: boolean;
}
