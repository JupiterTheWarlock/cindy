import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UnifiedModelEntry } from '@cindy/model-providers';

import { cn } from '@/lib/utils';
import { MODEL_PROTOCOL_LABEL } from '@/lib/modelProtocolLabel';
import { agentOptionOf } from './agentOptions';
import { agentKindOfEngine, engineOfAgentKind, type UnifiedEngine } from './unifiedModelSelection';

/** Recommendation, current selection, and protocol support are independent facts. */
export function ModelHarnessPicker({
  entry,
  value,
  disabled = false,
  locked = false,
  onChange,
}: {
  entry: UnifiedModelEntry;
  value: UnifiedEngine;
  disabled?: boolean;
  locked?: boolean;
  onChange: (engine: UnifiedEngine) => void;
}) {
  const { t } = useTranslation();
  const rank = (agent: UnifiedModelEntry['recommended']) =>
    agent === entry.recommended
      ? 0
      : entry.capabilities[agent]?.protocolMode === 'matching'
        ? 1
        : 2;
  // Candidate membership is already filtered by the executing device's availability and settings.
  // Opening this control must never re-enable hidden compatibility routes.
  const engines = locked
    ? [value]
    : [...entry.candidates].sort((a, b) => rank(a) - rank(b)).map(engineOfAgentKind);
  const nativeApi = entry.capabilities[agentKindOfEngine(value)]?.nativeApi;
  const interactive = !locked && engines.length > 1;

  return (
    <div
      role="group"
      aria-label={t('settings.providers.models.advanced.engines')}
      className="flex flex-col gap-1 pt-2"
    >
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-11">
        <span className="text-[var(--text-tertiary)]">
          {t('settings.providers.models.advanced.protocol.reference')}
        </span>
        <span className="text-[var(--text-secondary)]">
          {(nativeApi && MODEL_PROTOCOL_LABEL[nativeApi]) ||
            t('settings.providers.models.advanced.undeclared')}
        </span>
      </div>
      {engines.map((engine) => {
        const agent = agentKindOfEngine(engine);
        const option = agentOptionOf(engine);
        const capability = entry.capabilities[agent];
        const mode = capability?.protocolMode ?? 'unknown';
        const apiLabel = capability?.outboundApi && MODEL_PROTOCOL_LABEL[capability.outboundApi];
        const active = value === engine;
        const recommended = agent === entry.recommended;
        const label = engine === 'cc' ? 'Claude Code' : option.label;
        const supportLabel = t(`settings.providers.models.advanced.protocol.${mode}`);
        const detail = apiLabel ? `${apiLabel} · ${supportLabel}` : supportLabel;
        const recommendation = recommended
          ? ` · ${t('newChat.modelSelector.unified.recommended')}`
          : '';
        return (
          <button
            key={engine}
            type="button"
            disabled={disabled || !interactive}
            onClick={() => interactive && onChange(engine)}
            aria-pressed={active}
            aria-label={`${label} · ${detail}${recommendation}`}
            data-engine-capsule={engine}
            data-engine-active={active ? 'true' : undefined}
            data-engine-support={mode}
            className={cn(
              'flex w-full items-center gap-2 rounded-full border px-3 py-1.5 text-left transition-colors',
              mode === 'compatibility' ? 'border-dashed' : 'border-solid',
              active
                ? 'border-[var(--model-dropdown-border)] bg-[var(--surface-chip)] text-[var(--model-item-text)]'
                : 'border-transparent text-[var(--text-secondary)]',
              !active && interactive && 'hover:bg-[var(--model-item-hover)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--model-dropdown-border)]',
              interactive ? 'cursor-pointer' : 'cursor-default',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <span
              className="inline-flex h-5 w-4 shrink-0 self-start items-center justify-center"
              aria-hidden
            >
              <option.Mark size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-h-5 flex-wrap items-center gap-x-2">
                <span className="text-12 font-medium leading-5">{label}</span>
                {recommended && (
                  <span className="text-10 leading-4 text-[var(--text-tertiary)]">
                    {t('newChat.modelSelector.unified.recommended')}
                  </span>
                )}
              </span>
              <span className="block text-11 leading-4 text-[var(--text-tertiary)]">{detail}</span>
            </span>
            <Check size={13} aria-hidden className={cn('shrink-0', !active && 'invisible')} />
          </button>
        );
      })}
    </div>
  );
}
