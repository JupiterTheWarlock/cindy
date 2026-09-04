/**
 * ModelAdvancedDrawer —— 单个模型的全部只读事实与可配置项，从供应商详情面板右侧滑出。
 *
 * 为什么是抽屉而不是弹窗:这里要放的是「左标签右值 + 细分隔线」的定义列表,纵向空间比
 * 横向重要得多;弹窗宽而矮,同样的内容会被压成两栏或需要滚动两屏。
 *
 * 为什么行尾只有这一个入口:它替代了原先的「⋯」菜单。那个菜单里三项(自定义报价 /
 * 停用此模型 / 删除本机模型)全部搬进本抽屉 —— 一项能力都没减,但用户不必先猜「配置藏在
 * 哪个菜单里」。
 *
 * 分段职责:
 *   - 标识 / 规格 / 能力 / 报价 = **只读事实**,由目录与报价快照决定,用户改不了。
 *   - 默认推理强度 / 上下文上限 / 引擎支持 = **可配置项**,各自写入不同的既有存储
 *     (providerModelMemory / model-context-limit-store / modelVisibilityPrefs)。
 *   - 底部动作区 = 准入轴(停用)与本机文件(删除),与上面的显示轴严格分开。
 *
 * 「显示」与「停用」是两根正交的轴,语义见 UnifiedModelList 头注:开关管陈列,
 * 停用管准入。抽屉把它们放在视觉上分离的位置(引擎支持 vs 底部动作区),不混成一个控件。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { PiMark } from '@/components/icons/PiMark';
import { useModelContextLimit } from '@/hooks/useModelContextLimit';
import { modelPriceDetailRows, type ModelPricePresentation } from '@/lib/modelPriceFormat';
import {
  isModelEnabled,
  setModelVisibility,
  useModelVisibilityVersion,
} from '@/state/modelVisibilityPrefs';
import {
  getProviderModelEffort,
  setProviderModelEffort,
  useProviderModelMemoryVersion,
} from '@/state/providerModelMemory';
import { EFFORT_TIER_COLORS } from '@/themes/effortTierColors';

import { classifyVisionCapability, EFFORT_VALUES } from '@cindy/model-providers';
import type { AgentKind, CatalogModel, Effort, ProviderView } from '@cindy/model-providers';

import { MANAGED_OLLAMA_PROVIDER_ID } from '../../../shared/localModelRuntime';
import { ModelPriceOverrideDialog } from './ModelPriceOverrideDialog';
import type { UnionModelRow } from './UnifiedModelList';

const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

const AGENT_MARK: Record<AgentKind, (size: number) => ReactNode> = {
  'claude-code': (size) => <ClaudeMark size={size} />,
  codex: (size) => <CodexMark size={size} />,
  pi: (size) => <PiMark size={size} />,
};

const AGENT_MARK_COLOR: Record<AgentKind, string> = {
  'claude-code': 'var(--engine-badge-cc)',
  codex: 'var(--engine-badge-codex)',
  pi: 'var(--engine-badge-pi)',
};

/** 抽屉里的档位顺序 = 目录枚举顺序（弱到强）。ultra 只在模型真的提供时出现。 */
const EFFORT_ORDER = EFFORT_VALUES;

/**
 * K / M 缩写在真实数据里是**歧义的**:contextWindow 同时存在 1,000,000、1,050,000、
 * 1,048,576 三种写法,都会被印成「1M」。所以详情处一律给带千分位的准确 token 数,
 * 括注里才给约数 —— 列表那种空间紧的位置继续用缩写。
 */
function formatExactTokens(tokens: number, locale: string): string {
  return tokens.toLocaleString(locale);
}

function approxTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(2))}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** 定义列表的一行:左标签右值 + 细分隔线。 */
function Row({
  label,
  children,
  muted,
}: {
  label: string;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex min-h-[34px] items-center justify-between gap-4 border-b border-[var(--settings-theme-card-border)] py-2 last:border-b-0">
      <span className="shrink-0 text-13 text-[var(--text-secondary)]">{label}</span>
      <span
        className={cn(
          'min-w-0 truncate text-right text-13',
          muted ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]',
        )}
      >
        {children}
      </span>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pt-5 first:pt-1">
      <h4 className="text-11 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
        {title}
      </h4>
      {hint && (
        <p className="mt-1 text-12 leading-[1.5] text-[var(--text-tertiary)]">{hint}</p>
      )}
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

interface Props {
  provider: ProviderView;
  row: UnionModelRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 该行的报价展示（与列表同一份派生结果，避免抽屉自己再算一遍算出别的）。 */
  pricePresentationOf: (agent: AgentKind, model: CatalogModel) => ModelPricePresentation | null;
  /** 准入轴:停用此模型（main 侧 model-disable-store）。 */
  onDisable: (row: UnionModelRow) => void;
  /** 本机 Ollama 专有:删除磁盘上的模型文件。 */
  onDeleteLocal?: (row: UnionModelRow) => void;
  /** 该行当前是否已被停用（用于底部动作区的方向）。 */
  disabled: boolean;
  /** 付费锁定行不给写入入口（与列表行同一判定）。 */
  paymentRequired: boolean;
}

export function ModelAdvancedDrawer({
  provider,
  row,
  open,
  onOpenChange,
  pricePresentationOf,
  onDisable,
  onDeleteLocal,
  disabled,
  paymentRequired,
}: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const [priceDialogOpen, setPriceDialogOpen] = useState(false);
  // 开关/档位写的是 renderer 本地存储，订阅 version 才能在写后重渲染。
  useModelVisibilityVersion();
  useProviderModelMemoryVersion();

  /**
   * 主展示引擎:该模型可用引擎里的第一个。只读事实(上下文、报价、能力)按它取 ——
   * 同一模型跨引擎的元数据可能不同,抽屉顶部标注了这一点,逐引擎差异在「引擎支持」段展开。
   */
  const primaryAgent = row?.avail[0] ?? null;
  const primaryModel = row && primaryAgent ? (row.byAgent[primaryAgent] ?? null) : null;

  const contextTarget = useMemo(
    () =>
      primaryAgent && primaryModel
        ? { providerId: provider.id, agent: primaryAgent, modelId: primaryModel.id }
        : null,
    [primaryAgent, primaryModel, provider.id],
  );
  const ctx = useModelContextLimit(open ? contextTarget : null);

  // 输入框是受控字符串:直接绑数字会让「删到空」变成 0 而不是空。
  const [ctxDraft, setCtxDraft] = useState('');
  const ctxDirtyRef = useRef(false);
  const routeWindow = primaryModel?.contextWindow ?? 0;
  const effectiveLimit = ctx.limit ?? (routeWindow > 0 ? routeWindow : null);
  useEffect(() => {
    // 加载完成或切换模型时把草稿同步成真值；用户正在输入时不要打断。
    if (ctx.loading || ctxDirtyRef.current) return;
    setCtxDraft(effectiveLimit === null ? '' : String(Math.round(effectiveLimit / 1000)));
  }, [ctx.loading, effectiveLimit]);
  useEffect(() => {
    ctxDirtyRef.current = false;
  }, [contextTarget]);

  const commitCtxDraft = useCallback(
    (raw: string) => {
      ctxDirtyRef.current = true;
      setCtxDraft(raw);
      const trimmed = raw.trim();
      if (!trimmed) return; // 空 = 还没填完，不写盘
      const k = Number(trimmed);
      if (!Number.isFinite(k) || k <= 0) return;
      ctx.setLimit(Math.round(k * 1000));
    },
    [ctx],
  );

  const resetCtx = useCallback(() => {
    ctxDirtyRef.current = false;
    void ctx.reset();
  }, [ctx]);

  if (!row || !primaryAgent || !primaryModel) {
    return (
      <Dialog.Root open={false} onOpenChange={onOpenChange}>
        <Dialog.Portal />
      </Dialog.Root>
    );
  }

  const vision = classifyVisionCapability(primaryModel.id);
  const price = pricePresentationOf(primaryAgent, primaryModel);
  const draftK = Number(ctxDraft.trim());
  const overRouteWindow =
    routeWindow > 0 && Number.isFinite(draftK) && draftK > 0 && draftK * 1000 > routeWindow;

  const efforts = primaryModel.efforts ?? [];
  const currentEffort =
    getProviderModelEffort(primaryAgent, provider.id, primaryModel.id) ??
    primaryModel.defaultEffort ??
    null;
  const shownEfforts = EFFORT_ORDER.filter(
    (effort) => effort !== 'ultra' || efforts.includes('ultra'),
  );
  /**
   * 推理强度的存储是 per (agent, provider, model) 的。这里按显示轴同一条哲学
   * **一次写该模型全部可用引擎** —— 用户在这个面板里选的是「这个模型默认想多用力」,
   * 而不是「它在 Codex 下用力、在 Claude Code 下不用力」。逐引擎覆盖是目录的事
   * (perAgent.defaultEffort),在下方引擎行标注出来。
   */
  const applyEffort = (effort: Effort) => {
    for (const agent of row.avail) {
      const model = row.byAgent[agent];
      if (!model) continue;
      if (!(model.efforts ?? []).includes(effort)) continue;
      setProviderModelEffort(agent, provider.id, model.id, effort);
    }
  };

  const isLocalOllama = provider.id === MANAGED_OLLAMA_PROVIDER_ID;

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay
            className={cn(
              'fixed inset-0 z-[10001] bg-[var(--overlay-modal)]',
              'data-[state=open]:animate-confirm-overlay-in',
              'data-[state=closed]:animate-confirm-overlay-out',
            )}
          />
          <Dialog.Content
            className={cn(
              'fixed right-0 top-0 z-[10001] flex h-full w-[436px] max-w-[92vw] flex-col',
              'border-l border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
              // 从右缘推进来。Radix 自己管 mount 与 data-state 的时序，所以不需要
              // 手动延迟一帧加 class —— 直接带终态入 DOM 会让过渡不播，这是纯 DOM
              // 实现里最容易踩的坑。
              'data-[state=open]:animate-drawer-in-right',
              'data-[state=closed]:animate-drawer-out-right',
            )}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            aria-describedby={undefined}
          >
            <header className="flex items-start gap-3 border-b border-[var(--settings-theme-card-border)] px-5 pb-3 pt-4">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="truncate text-15 font-medium text-[var(--text-primary)]">
                  {primaryModel.name}
                </Dialog.Title>
                <p className="mt-0.5 truncate text-12 text-[var(--text-tertiary)]">
                  {primaryModel.description ?? t('settings.providers.models.advanced.noDescription')}
                </p>
              </div>
              <Dialog.Close
                className="-mr-1 -mt-1 shrink-0 rounded-lg p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] hover:text-[var(--text-primary)]"
                aria-label={t('common.close')}
              >
                <X size={16} />
              </Dialog.Close>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
              <Section title={t('settings.providers.models.advanced.identity')}>
                <Row label={t('settings.providers.models.advanced.modelId')}>
                  <code className="text-12">{primaryModel.id}</code>
                </Row>
                <Row label={t('settings.providers.models.advanced.providerLabel')} muted>
                  {provider.name}
                </Row>
                {primaryModel.group && (
                  <Row label={t('settings.providers.models.advanced.group')} muted>
                    <code className="text-12">{primaryModel.group}</code>
                  </Row>
                )}
                <Row label={t('settings.providers.models.advanced.status')} muted>
                  {primaryModel.status ?? t('settings.providers.models.advanced.statusUnset')}
                </Row>
                <Row label={t('settings.providers.models.advanced.defaultEnabled')} muted>
                  {primaryModel.defaultEnabled === false
                    ? t('settings.providers.models.advanced.defaultEnabledOff')
                    : t('settings.providers.models.advanced.defaultEnabledOn')}
                </Row>
              </Section>

              <Section title={t('settings.providers.models.advanced.spec')}>
                <Row label={t('settings.providers.models.advanced.contextWindow')}>
                  {routeWindow > 0 ? (
                    <>
                      {formatExactTokens(routeWindow, locale)}
                      <span className="ml-1 text-11 text-[var(--text-tertiary)]">
                        {t('settings.providers.models.advanced.tokensApprox', {
                          approx: approxTokens(routeWindow),
                        })}
                      </span>
                    </>
                  ) : (
                    <span className="text-[var(--text-tertiary)]">
                      {t('settings.providers.models.advanced.catalogMissing')}
                    </span>
                  )}
                </Row>
              </Section>

              <Section
                title={t('settings.providers.models.advanced.capability')}
                hint={t('settings.providers.models.advanced.capabilityHint')}
              >
                <Row label={t('settings.providers.models.advanced.imageInput')}>
                  <span title={t(`settings.providers.models.advanced.visionSource.${vision}`)}>
                    {t(`settings.providers.models.advanced.vision.${vision}`)}
                  </span>
                </Row>
                <Row label="Fast" muted>
                  {primaryModel.supportsFastMode === true
                    ? t('settings.providers.models.advanced.supported')
                    : primaryModel.supportsFastMode === false
                      ? t('settings.providers.models.advanced.unsupported')
                      : t('settings.providers.models.advanced.undeclared')}
                </Row>
              </Section>

              <Section title={t('settings.providers.models.advanced.pricing')}>
                {price === null ? (
                  <Row label={t('settings.providers.models.advanced.pricingLabel')} muted>
                    {t('settings.providers.models.advanced.noPricing')}
                  </Row>
                ) : price.kind === 'free' ? (
                  <Row label={t('settings.providers.models.advanced.pricingLabel')}>
                    {t('newChat.modelSelector.pricing.free')}
                  </Row>
                ) : (
                  modelPriceDetailRows(price.current, price.original).map((detail) => (
                    <Row
                      key={detail.kind}
                      label={t(`settings.providers.models.advanced.price.${detail.kind}`)}
                    >
                      {/* 有折扣时给**实付价**，标准价划掉跟在后面：只写标准价再另起一行
                          「折扣 40%」等于让人自己乘一遍，而实付才是他要判断的数。 */}
                      {detail.value}
                      {detail.originalValue && (
                        <span className="ml-1.5 text-11 text-[var(--text-tertiary)] line-through">
                          {detail.originalValue}
                        </span>
                      )}
                      <span className="ml-1 text-11 text-[var(--text-tertiary)]">
                        {t('settings.providers.models.advanced.perMtok')}
                      </span>
                    </Row>
                  ))
                )}
                {price?.kind === 'priced' && price.discount !== undefined && (
                  <Row label={t('settings.providers.models.advanced.discount')}>
                    <span
                      className="inline-flex items-center rounded-full px-2 py-[1px] text-10 font-medium"
                      style={{
                        color: EFFORT_TIER_COLORS.low,
                        backgroundColor: `color-mix(in srgb, ${EFFORT_TIER_COLORS.low} 14%, transparent)`,
                      }}
                    >
                      {`↓${Math.round(price.discount * 100)}%`}
                    </span>
                  </Row>
                )}
                {/* 自定义报价:原「⋯」菜单的一项,搬到它真正相关的段落里。
                    XD 网关的价格由服务端定,不给覆盖入口(与 IPC 侧的拒绝一致)。 */}
                {provider.id !== 'xd' && !paymentRequired && (
                  <button
                    type="button"
                    onClick={() => setPriceDialogOpen(true)}
                    className="mt-2 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                  >
                    {t('settings.providers.models.priceOverride.menu')}
                  </button>
                )}
              </Section>

              {efforts.length > 0 && (
                <Section
                  title={t('settings.providers.models.advanced.defaultEffort')}
                  hint={t('settings.providers.models.advanced.defaultEffortHint')}
                >
                  <div className="mt-1 flex rounded-lg border border-[var(--settings-theme-card-border)] p-[3px]">
                    {shownEfforts.map((effort) => {
                      const available = efforts.includes(effort);
                      const active = currentEffort === effort;
                      return (
                        <button
                          key={effort}
                          type="button"
                          disabled={!available || paymentRequired}
                          onClick={() => applyEffort(effort)}
                          className={cn(
                            'flex-1 rounded-md py-1 text-12 transition-colors',
                            active
                              ? 'bg-[var(--settings-menu-bg-hover)] text-[var(--text-primary)]'
                              : available
                                ? 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                                : 'cursor-not-allowed text-[var(--text-tertiary)] opacity-45',
                          )}
                        >
                          {t(`effortLevels.${effort}`)}
                        </button>
                      );
                    })}
                  </div>
                </Section>
              )}

              {routeWindow > 0 && (
                <Section
                  title={t('settings.providers.models.advanced.contextLimit')}
                  hint={t('settings.providers.models.advanced.contextLimitHint')}
                >
                  <div className="mt-1 flex items-center gap-2.5">
                    <span
                      className={cn(
                        'inline-flex h-7 items-center gap-1 rounded-lg border px-2',
                        overRouteWindow
                          ? 'border-[var(--warning-fg)]'
                          : 'border-[var(--settings-theme-card-border)]',
                      )}
                    >
                      <input
                        value={ctxDraft}
                        onChange={(event) => commitCtxDraft(event.target.value)}
                        inputMode="numeric"
                        disabled={paymentRequired}
                        aria-label={t('settings.providers.models.advanced.contextLimitAria')}
                        className="w-11 bg-transparent text-center text-13 tabular-nums text-[var(--text-primary)] outline-none"
                      />
                      <span className="text-11 text-[var(--text-tertiary)]">K</span>
                    </span>
                    <span className="min-w-0 flex-1 truncate text-11 tabular-nums text-[var(--text-tertiary)]">
                      {t('settings.providers.models.advanced.contextLimitRoute', {
                        tokens: formatExactTokens(routeWindow, locale),
                      })}
                    </span>
                    {ctx.isCustomized && (
                      <button
                        type="button"
                        onClick={resetCtx}
                        className="shrink-0 text-11 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)]"
                      >
                        {t('settings.providers.models.advanced.restoreDefault')}
                      </button>
                    )}
                  </div>
                  {overRouteWindow && (
                    <p className="mt-1.5 flex items-start gap-1.5 text-11 leading-[1.5] text-[var(--warning-fg)]">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      {t('settings.providers.models.advanced.contextLimitOverWindow')}
                    </p>
                  )}
                </Section>
              )}

              <Section
                title={t('settings.providers.models.advanced.engines')}
                hint={t('settings.providers.models.advanced.enginesHint')}
              >
                {provider.agents.map((agent) => {
                  const model = row.byAgent[agent];
                  const supported = Boolean(model);
                  const notes: string[] = [];
                  if (model) {
                    // 同一模型在不同引擎下的元数据差异如实标出来 —— 这些值来自目录的
                    // perAgent 覆盖，用户看到「Codex 下 272K / 6 档」才知道差异是真的。
                    if (model.contextWindow > 0 && model.contextWindow !== routeWindow) {
                      notes.push(approxTokens(model.contextWindow));
                    }
                    if (model.defaultEffort && model.defaultEffort !== primaryModel.defaultEffort) {
                      notes.push(
                        t('settings.providers.models.advanced.engineDefaultEffort', {
                          effort: t(`effortLevels.${model.defaultEffort}`),
                        }),
                      );
                    }
                    if (
                      model.supportsFastMode === false &&
                      primaryModel.supportsFastMode === true
                    ) {
                      notes.push(t('settings.providers.models.advanced.engineNoFast'));
                    }
                  }
                  return (
                    <div
                      key={agent}
                      className={cn(
                        'flex min-h-[34px] items-center gap-2.5 border-b border-[var(--settings-theme-card-border)] py-2 last:border-b-0',
                        !supported && 'opacity-50',
                      )}
                    >
                      <span
                        className="shrink-0"
                        style={{ color: AGENT_MARK_COLOR[agent] }}
                        aria-hidden
                      >
                        {AGENT_MARK[agent](14)}
                      </span>
                      <span className="shrink-0 text-13 text-[var(--text-primary)]">
                        {AGENT_LABEL[agent]}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-right text-11 text-[var(--text-tertiary)]">
                        {supported
                          ? notes.join(' · ')
                          : t('settings.providers.models.advanced.engineUnsupported')}
                      </span>
                      <Switch
                        checked={supported ? isModelEnabled(agent, provider.id, model!) : false}
                        disabled={!supported || paymentRequired}
                        onCheckedChange={(next) => {
                          if (!model) return;
                          if (setModelVisibility(agent, provider.id, model.id, next) === false) {
                            toast.error(t('settings.providers.models.visibilityWriteFailed'));
                          }
                        }}
                        aria-label={`${primaryModel.name} · ${AGENT_LABEL[agent]}`}
                      />
                    </div>
                  );
                })}
              </Section>

              {/* 动作区:准入轴与本机文件。与上面的显示轴刻意隔开一段留白 ——
                  它们不是同一件事,放在一起会让人以为关了开关就等于停用。 */}
              {!paymentRequired && (
                <div className="mt-7 flex flex-col gap-2 border-t border-[var(--settings-theme-card-border)] pt-4">
                  <button
                    type="button"
                    onClick={() => onDisable(row)}
                    className="h-8 rounded-lg border border-[var(--settings-btn-secondary-border)] text-13 text-[var(--settings-btn-secondary-text)] transition-colors hover:bg-[var(--settings-menu-bg-hover)]"
                  >
                    {disabled
                      ? t('settings.providers.models.enableModel')
                      : t('settings.providers.models.disableModel')}
                  </button>
                  {isLocalOllama && onDeleteLocal && (
                    <button
                      type="button"
                      onClick={() => onDeleteLocal(row)}
                      className="flex h-8 items-center justify-center gap-1.5 rounded-lg text-13 text-[var(--error-flat)] transition-colors hover:bg-[var(--settings-menu-bg-hover)]"
                    >
                      <Trash2 size={13} />
                      {t('settings.providers.local.deleteModel')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {priceDialogOpen && (
        <ModelPriceOverrideDialog
          provider={provider}
          row={row}
          open={priceDialogOpen}
          onOpenChange={setPriceDialogOpen}
        />
      )}
    </>
  );
}
