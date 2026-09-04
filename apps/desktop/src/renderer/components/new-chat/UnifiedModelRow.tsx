import { Lock, Star, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

import type { ProviderView, UnifiedModelEntry } from '@cindy/model-providers';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import { cn } from '@/lib/utils';
import type { Effort } from '@/lib/userPreferences.types';


import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { PiMark } from '@/components/icons/PiMark';
import type { ModelPickerLayout } from '@/state/modelPickerLayout';

import { agentOptionOf } from './agentOptions';
// 图标规则(模型条目 icon 优先、缺省回落来源供应商标)只有一份实现,复用它而不是抄一份。
import { ModelIconMark } from './ModelSelector';
// 价格档串与设置页 → 模型列表共用同一份实现(见 priceTierMarks.tsx 头注)。
import {
  litFractionalMarks,
  litWholeMarks,
  PriceFreeBadge,
  PriceTierMarks,
  type UnifiedRowPriceDisplay,
} from './priceTierMarks';
import {
  anchorKey,
  type UnifiedAnchor,
  type UnifiedEngine,
  type UnifiedRowConfig,
} from './unifiedModelSelection';

/**
 * badge 样式的引擎徽标底色 —— 一律走**语义 token**(themes/colors.ts 的
 * `engine-badge-*`),这里只持有变量名,不留任何 hex 字面量:数值正本在注册处,
 * 那边也写清了三支色各自的来源与「light / dark 同值是有意决策」的理由。
 * 徽标底(14%)与描边(30%)由下面的 color-mix 从**同一个 var** 派生,PiMark 的
 * currentColor 也接它 —— 一处改色三处同步,不会出现组件与主题各画各的。
 */
const ENGINE_BADGE_TINT: Record<UnifiedEngine, string> = {
  cc: 'var(--engine-badge-cc)',
  codex: 'var(--engine-badge-codex)',
  pi: 'var(--engine-badge-pi)',
};

/**
 * 行内价格展示(设计稿 v4 定稿的 F 样式)的类型与档串组件已抽到 `./priceTierMarks`,
 * 与设置页 → 模型列表共用一份实现。这里 re-export 供既有 import 路径继续可用。
 */
export type { UnifiedRowPriceDisplay };

/** 单行(双行布局):L1 图标 · 名称 · ☆ · 三元组 · 勾;L2 一句描述。 */
export function UnifiedModelRow({
  entry,
  anchor,
  config,
  selected,
  active,
  isFavoriteRow,
  justFavorited,
  interactionDisabled,
  effortLabelOf,
  providers,
  onReveal,
  onLeave,
  onBlurAway,
  onSelect,
  onStar,
  onRevealForKeyboard,
  priceDisplay,
  subscriptionLabel,
  layout = 'classic',
  channelLabel,
  onEngineCycle,
  paymentRequired = false,
  paymentRequiredLabel,
  paymentRequiredUnlockLabel,
  onPaymentRequired,
}: {
  entry: UnifiedModelEntry;
  anchor: UnifiedAnchor;
  config: UnifiedRowConfig;
  selected: boolean;
  active: boolean;
  isFavoriteRow: boolean;
  justFavorited: boolean;
  interactionDisabled: boolean;
  effortLabelOf: (agent: AgentKind, effort: Effort) => string;
  providers: readonly ProviderView[];
  onReveal: (anchor: UnifiedAnchor, element: HTMLElement) => void;
  /** pointerleave —— 带事件:调用方按「往哪边走」决定 grace 长短(去浮层的路上要更宽容)。 */
  onLeave: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** 焦点离开本行:调用方按「新焦点是否落在浮层里」决定收不收(← 键进浮层不能被收掉)。 */
  onBlurAway: (related: EventTarget | null) => void;
  onSelect: () => void;
  onStar: () => void;
  /** ← 键:打开该行的配置浮层并把焦点送进去(键盘用户的浮层入口,与既有面板同键位)。 */
  onRevealForKeyboard: (anchor: UnifiedAnchor, element: HTMLElement) => void;
  /** 行内价格展示;不传 = 无报价。字段语义见 `UnifiedRowPriceDisplay`。 */
  priceDisplay?: UnifiedRowPriceDisplay;
  /**
   * 已本地化的「订阅」小签(设计稿 `.badge.sub`)。仅**订阅接入且无按量报价**的行传 ——
   * 那类模型走套餐额度,行内画 $ 档串会误导成按量计费。
   */
  subscriptionLabel?: string;
  /**
   * 列表样式(modelPickerLayout 试用开关):
   *   - 'classic'(默认):现行双行布局,行首来源图标、引擎在行尾三元组;
   *   - 'badge':v7 设计稿单行布局 —— 行首 22px **引擎徽标**(官方 mark + 品牌色底,
   *     点按在候选引擎间快切),右缘常驻**来源字签**(channelLabel),价格串按实付
   *     比例上色(0.5 字符下限,见 badge 分支头注)。
   */
  layout?: ModelPickerLayout;
  /** badge 样式右缘的来源字签文案(providerLabel 的既有结果,不另造词)。 */
  channelLabel?: string;
  /** badge 样式行首徽标点按 = 切到下一个候选引擎;单候选行不传(徽标不可点)。 */
  onEngineCycle?: () => void;
  /** 付费锁定行保留在原位置，可聚焦但不能选中、收藏或打开配置。 */
  paymentRequired?: boolean;
  paymentRequiredLabel?: string;
  paymentRequiredUnlockLabel?: string;
  onPaymentRequired?: () => void;
}) {
  const { t } = useTranslation();
  const provider = providers.find((item) => item.id === entry.providerId);
  const priceSymbol = priceDisplay?.symbol ?? '$';
  const engineOption = agentOptionOf(config.engine);
  const reveal = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!paymentRequired) onReveal(anchor, event.currentTarget);
  };
  const tripleTitle = `${engineOption.label}${
    config.effort ? ` · ${effortLabelOf(config.agent, config.effort)}` : ''
  }${config.fast ? ' · Fast' : ''}`;
  const paymentRequiredActionLabel = paymentRequired
    ? [entry.displayName, paymentRequiredUnlockLabel ?? paymentRequiredLabel]
        .filter(Boolean)
        .join(' · ')
    : undefined;

  // 行根节点的交互与语义两种样式完全一致(选中/浮层/键盘),只有布局不同 —— 抽成
  // 共享 props,badge 分支不复制一遍手写事件导致行为漂移。
  const rowRootProps = {
    role: 'option' as const,
    'aria-selected': selected,
    // 付费行不能被选为模型，但它本身是“查看付费说明”的可执行入口；只有真正
    // 阻断全部交互的状态才声明 disabled，避免读屏软件抑制 Enter / Space 激活。
    'aria-disabled': interactionDisabled ? true : undefined,
    'aria-label': paymentRequiredActionLabel,
    // ← 开配置浮层是这一行唯一的键盘入口,不声明就只有摸索得到(读屏用户尤甚)。
    'aria-keyshortcuts': paymentRequired ? undefined : 'ArrowLeft',
    tabIndex: interactionDisabled ? -1 : 0,
    'data-model-selected': selected ? ('true' as const) : undefined,
    'data-unified-anchor': anchorKey(anchor),
    onPointerEnter: reveal,
    onPointerMove: reveal,
    onPointerLeave: onLeave,
    onFocus: (event: ReactFocusEvent<HTMLDivElement>) => {
      if (!paymentRequired) onReveal(anchor, event.currentTarget);
    },
    onBlur: (event: ReactFocusEvent<HTMLDivElement>) => onBlurAway(event.relatedTarget),
    onClick: () => {
      if (interactionDisabled) return;
      if (paymentRequired) onPaymentRequired?.();
      else onSelect();
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || interactionDisabled) return;
      if (paymentRequired) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onPaymentRequired?.();
        }
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onRevealForKeyboard(anchor, event.currentTarget);
        return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSelect();
    },
  };

  const starButton = (
    <button
      type="button"
      disabled={interactionDisabled || paymentRequired}
      onClick={(event) => {
        event.stopPropagation();
        onStar();
      }}
      title={
        isFavoriteRow
          ? t('newChat.modelSelector.unified.removeFavorite')
          : t('newChat.modelSelector.unified.addFavorite')
      }
      aria-label={
        isFavoriteRow
          ? t('newChat.modelSelector.unified.removeFavorite')
          : t('newChat.modelSelector.unified.addFavorite')
      }
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] transition-opacity',
        isFavoriteRow || justFavorited
          ? 'text-[var(--favorite-star)] opacity-100'
          : 'text-[var(--text-tertiary)] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-[var(--favorite-star)]',
      )}
    >
      <Star size={14} fill={isFavoriteRow || justFavorited ? 'currentColor' : 'none'} />
    </button>
  );
  const paymentRequiredBadge =
    paymentRequired && paymentRequiredLabel ? (
      <span
        data-payment-required-badge
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-10 font-normal leading-[1.45] text-[var(--text-secondary)]"
      >
        <Lock size={10} />
        {paymentRequiredLabel}
      </span>
    ) : null;
  const paymentRequiredUnlock =
    paymentRequired && paymentRequiredUnlockLabel ? (
      <span
        data-payment-required-unlock
        className="invisible shrink-0 select-none text-11 font-medium text-[var(--text-secondary)] group-hover/row:visible group-focus-within/row:visible"
      >
        {paymentRequiredUnlockLabel}
      </span>
    ) : null;

  if (layout === 'badge') {
    const tint = ENGINE_BADGE_TINT[config.engine];
    const badgeMark =
      config.engine === 'cc' ? (
        <ClaudeMark size={13} variant="brand" />
      ) : config.engine === 'codex' ? (
        <CodexMark size={14} variant="brand" />
      ) : (
        // PiMark 上游无官方品牌色,只有 currentColor 一条路 —— 底色由下面 badgeStyle 的
        // `color` 给,取的就是 ENGINE_BADGE_TINT.pi,不在这里手抄第二份色号。
        <PiMark size={13} />
      );
    const badgeStyle = {
      backgroundColor: `color-mix(in srgb, ${tint} 14%, transparent)`,
      boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tint} 30%, transparent)`,
      // 给 currentColor 兜底(pi 的 mark 靠它染色);cc / codex 的 brand variant 自带
      // 固定配色,继承下来的 color 用不上。
      color: tint,
    };
    return (
      <div
        {...rowRootProps}
        className={cn(
          'group/row flex h-[38px] w-full cursor-pointer items-center gap-2 rounded-[10px] px-2.5 transition-colors duration-100',
          'hover:bg-[var(--model-item-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          (selected || active) && 'bg-[var(--model-item-hover)]',
          (interactionDisabled || paymentRequired) && 'cursor-not-allowed opacity-50',
        )}
      >
        {/* 引擎徽标 = 本样式唯一的图标系统:官方 mark + 品牌色底。可点时在候选引擎间
            快切(与浮层引擎胶囊同一条 applyEngine 链路,语义一致);单候选行只作标识。 */}
        {onEngineCycle && !interactionDisabled && !paymentRequired ? (
          <button
            type="button"
            data-engine-badge={config.engine}
            title={engineOption.label}
            aria-label={engineOption.label}
            onClick={(event) => {
              event.stopPropagation();
              onEngineCycle();
            }}
            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px] transition-transform hover:scale-110 active:scale-95"
            style={badgeStyle}
          >
            {badgeMark}
          </button>
        ) : (
          <span
            data-engine-badge={config.engine}
            title={engineOption.label}
            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px]"
            style={badgeStyle}
          >
            {badgeMark}
          </span>
        )}
        <span
          title={
            entry.description ? `${entry.displayName} — ${entry.description}` : entry.displayName
          }
          className="min-w-0 truncate text-14 font-medium leading-5 text-[var(--model-item-text)]"
        >
          {entry.displayName}
        </span>
        {subscriptionLabel && (
          <span
            data-subscription-badge
            className="inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-10 font-normal leading-[1.45] text-[var(--text-secondary)]"
          >
            {subscriptionLabel}
          </span>
        )}
        {priceDisplay?.kind === 'free' && (
          <PriceFreeBadge label={t('newChat.modelSelector.pricing.free')} />
        )}
        {priceDisplay?.kind === 'tier' && priceDisplay.tier !== undefined && (
          <PriceTierMarks
            priceDisplay={priceDisplay}
            symbol={priceSymbol}
            tier={priceDisplay.tier}
            litOf={litFractionalMarks}
            formatClipPct={(pct) => pct.toFixed(1)}
            exposeLit
          />
        )}
        {starButton}
        {/* 右缘簇:⚡ + 档位字 + 来源字签(常驻,任何滚动位置都读得出这行是谁家的)。
            引擎不再进右簇 —— 行首徽标已承载。 */}
        <span
          title={tripleTitle}
          data-model-row-meta
          // 外侧簇颜色恒定(Chris 2026-08-16 实测:调过思考深度后行右侧不该变色;
          // 「已自定义」的信号由浮层底栏承载,不再用行内提亮表达)。
          className="ml-auto flex shrink-0 items-center gap-2 text-12 text-[var(--text-tertiary)]"
        >
          {config.fast && (
            <Zap
              size={11}
              fill="currentColor"
              className="shrink-0"
              aria-label={t('newChat.modelSelector.meta.fastBadge')}
            />
          )}
          {config.effort && <span>{effortLabelOf(config.agent, config.effort)}</span>}
          {paymentRequiredUnlock}
          {paymentRequiredBadge}
          {channelLabel && (
            <span
              data-channel-tag
              className="whitespace-nowrap rounded-[4px] border border-[var(--model-dropdown-border)] px-1.5 py-px text-10 text-[var(--text-tertiary)]"
            >
              {channelLabel}
            </span>
          )}
        </span>
      </div>
    );
  }

  return (
    <div
      {...rowRootProps}
      className={cn(
        'group/row flex w-full cursor-pointer flex-col rounded-[10px] px-2.5 py-2 transition-colors duration-100',
        'hover:bg-[var(--model-item-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        (selected || active) && 'bg-[var(--model-item-hover)]',
        (interactionDisabled || paymentRequired) && 'cursor-not-allowed opacity-50',
      )}
    >
      <div className="flex items-center gap-2">
        {/* 设计稿 .mark:18×18 定位盒(图标本体 13-17px 居中)。没有这个盒,名字起点
            随图标实际宽度浮动,第二行描述的 26px 缩进(18+8)就对不上第一行的名字。 */}
        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
          <ModelIconMark
            {...(entry.icon !== undefined ? { icon: entry.icon } : {})}
            providerId={entry.providerId}
            {...(provider?.name !== undefined ? { name: provider.name } : {})}
            {...(provider?.routing !== undefined ? { routing: provider.routing } : {})}
            {...(provider?.logoKind !== undefined ? { logoKind: provider.logoKind } : {})}
            colorClass="text-[var(--text-secondary)]"
            withMargin={false}
          />
        </span>
        <span
          // 布局同设计稿 .m-name:内容宽、不 grow —— 徽标/钱串紧贴模型名左排,
          // 右侧三元组由 ml-auto 推到最右;空间不足时名字先收缩截断,title 给全名。
          // 字号/字重**不跟设计稿的 13.5px/normal**,按旧选择器恢复(text-14 + medium):
          // Chris 2026-08-13 实测裁决 —— 名字变小去粗后与描述行难以区分。
          title={entry.displayName}
          className="min-w-0 truncate text-14 font-medium leading-5 text-[var(--model-item-text)]"
        >
          {entry.displayName}
        </span>
        {subscriptionLabel && (
          <span
            data-subscription-badge
            className="inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-10 font-normal leading-[1.45] text-[var(--text-secondary)]"
          >
            {subscriptionLabel}
          </span>
        )}
        {priceDisplay?.kind === 'free' && (
          <PriceFreeBadge label={t('newChat.modelSelector.pricing.free')} />
        )}
        {priceDisplay?.kind === 'tier' && priceDisplay.tier !== undefined && (
          <PriceTierMarks
            priceDisplay={priceDisplay}
            symbol={priceSymbol}
            tier={priceDisplay.tier}
            litOf={litWholeMarks}
            // classic 的裁切百分比恒是整数(整格点亮),按既有 DOM 形态不带小数。
            formatClipPct={(pct) => String(pct)}
            exposeLit={false}
          />
        )}
        {starButton}
        {/* 常驻三元组:引擎图标 + 推理强度 + ⚡。所有行同构,自定义行整组提亮一档。
            设计稿 .l1-right:margin-left auto 把右侧簇推到最右,左侧簇贴名字排。 */}
        <span data-model-row-meta className="ml-auto flex shrink-0 items-center gap-2">
          <span
            title={tripleTitle}
            data-unified-triple
            // 颜色恒定,不随「已自定义」提亮(Chris 2026-08-16 裁决,同 badge 样式)。
            className="flex max-w-[118px] shrink-0 items-center gap-1 truncate text-12 text-[var(--text-tertiary)]"
          >
            <engineOption.Mark size={12} className="shrink-0" />
            {config.effort && (
              <span className="truncate">{effortLabelOf(config.agent, config.effort)}</span>
            )}
            {config.fast && (
              <Zap
                size={11}
                fill="currentColor"
                className="shrink-0"
                aria-label={t('newChat.modelSelector.meta.fastBadge')}
              />
            )}
          </span>
          {paymentRequiredUnlock}
          {paymentRequiredBadge}
        </span>
        {/* 行尾不放 ✅(Chris 2026-08-13 裁决:选中已有整行底色,再加勾是重复信号,
            还平白吃掉一列宽度);选中态语义由 aria-selected 承载。 */}
      </div>
      {entry.description && (
        // 单行截断 + title 全文;宽度上限收紧到约等于最长模型名的量级(~30ch)——
        // 描述是辅助信息,不该比模型名更长地占据视线(2026-08-13 实测反馈)。
        // 颜色按旧选择器恢复用 --text-secondary(同日裁决:tertiary 太淡看不清;
        // 与名字的区分靠名字的 14px/medium,不靠把描述压淡)。
        <div
          title={entry.description}
          className="min-w-0 max-w-[30ch] truncate pl-[26px] pt-px text-12 leading-[1.4] text-[var(--text-secondary)]"
        >
          {entry.description}
        </div>
      )}
    </div>
  );
}
