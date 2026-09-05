// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';

const mocks = vi.hoisted(() => ({
  setLimit: vi.fn(async () => {}),
  reset: vi.fn(async () => {}),
  target: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.tokens ? `${key} ${values.tokens}` : key,
    i18n: { resolvedLanguage: 'en' },
  }),
}));
vi.mock('@/hooks/useModelContextLimit', () => ({
  useModelContextLimit: (target: unknown) => {
    mocks.target(target);
    return {
      limit: null,
      isCustomized: false,
      loading: false,
      error: false,
      setLimit: mocks.setLimit,
      reset: mocks.reset,
    };
  },
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  useModelVisibilityVersion: () => 0,
  isModelEnabled: () => true,
  isModelVisibilityCustomized: () => false,
  setModelVisibility: vi.fn(),
  resetModelVisibilities: vi.fn(),
}));
vi.mock('@/state/providerModelMemory', () => ({
  useProviderModelMemoryVersion: () => 0,
  getProviderModelEffort: () => undefined,
  setProviderModelEffort: vi.fn(),
  clearProviderModelEffort: vi.fn(),
}));
vi.mock('../ModelPriceOverrideDialog', () => ({ ModelPriceOverrideDialog: () => null }));
import { ModelAdvancedDrawer } from '../ModelAdvancedDrawer';

const model: CatalogModel = {
  id: 'gpt-6',
  name: 'GPT-6',
  contextWindow: 272_000,
  contextWindowMax: 1_050_000,
  maxOutput: 128_000,
  efforts: ['low', 'high'],
  defaultEffort: 'high',
  modalities: { input: ['text', 'image'], output: ['text'] },
};
const provider = {
  id: 'openai',
  name: 'OpenAI',
  source: 'builtin',
  agents: ['codex', 'claude-code'],
  models: {},
} as ProviderView;
function drawer(primary = model, bridgeDefault = primary.defaultEffort) {
  const row = {
    id: primary.id,
    name: primary.name,
    avail: ['codex', 'claude-code'] as ('codex' | 'claude-code')[],
    byAgent: {
      codex: primary,
      'claude-code': { ...primary, id: `chatgpt/${primary.id}`, defaultEffort: bridgeDefault },
    },
  };
  return (
    <ModelAdvancedDrawer
      provider={provider}
      row={row}
      open
      onOpenChange={vi.fn()}
      pricePresentationOf={() => null}
      onDisable={vi.fn()}
      disabled={false}
      paymentRequired={false}
    />
  );
}
function draw(primary = model, bridgeDefault = primary.defaultEffort) {
  return render(drawer(primary, bridgeDefault));
}
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('model advanced editor', () => {
  it('shows the exact maximum and recommended value, then writes one row edit using both aliases', () => {
    draw();
    expect(screen.getByText('1,050,000')).toBeTruthy();
    const input = screen.getByRole('textbox', {
      name: 'settings.providers.models.advanced.contextLimitAria',
    });
    expect((input as HTMLInputElement).value).toBe('272');
    fireEvent.change(input, { target: { value: '500.125' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledWith(500_125);
    // 1.001 * 1000 is 1000.9999999999999 in JS; whole tokens must survive conversion.
    fireEvent.change(input, { target: { value: '1.001' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenLastCalledWith(1001);
    expect(mocks.target).toHaveBeenLastCalledWith({
      providerId: 'openai',
      agent: 'codex',
      modelId: 'gpt-6',
      relatedTargets: [{ providerId: 'openai', agent: 'claude-code', modelId: 'chatgpt/gpt-6' }],
    });
  });

  it('shows facts beside controls without disclosure and keeps related window values together', () => {
    draw();
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('details')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'GPT-6' }));
    const input = screen.getByRole('textbox');
    const controlsColumn = input.closest('section')!.parentElement!;
    expect(controlsColumn.textContent).toContain(
      'settings.providers.models.advanced.contextWindow',
    );
    expect(screen.getByText('settings.providers.models.advanced.imageInput')).toBeTruthy();
    expect(screen.getByText('settings.providers.models.advanced.modelId')).toBeTruthy();
    const scrollArea = input.closest('.overflow-y-auto')!;
    expect(
      scrollArea.contains(
        screen.getByRole('button', { name: 'settings.providers.models.disableModel' }),
      ),
    ).toBe(false);
    const close = screen.getByRole('button', { name: 'settings.providers.models.advanced.close' });
    fireEvent.focus(close);
    expect(close.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it.each([
    ['anthropic-claude/claude-opus-4-8', ['claude-code', 'codex', 'pi'], 'Claude Code'],
    ['new-vendor/gpt-9', ['claude-code', 'codex', 'pi'], 'Codex'],
    ['new-labs/next-model', ['pi'], 'Pi'],
  ] as const)('uses the shared recommendation for %s', (id, agents, expected) => {
    const primary = { ...model, id, name: id };
    const models = Object.fromEntries(agents.map((agent) => [agent, [primary]]));
    render(
      <ModelAdvancedDrawer
        provider={{ ...provider, id: 'xd', agents: [...agents], models }}
        row={{
          id,
          name: id,
          avail: [...agents],
          byAgent: Object.fromEntries(agents.map((agent) => [agent, primary])),
        }}
        open
        onOpenChange={vi.fn()}
        pricePresentationOf={() => null}
        onDisable={vi.fn()}
        disabled={false}
        paymentRequired={false}
      />,
    );
    const marker = screen.getByText('newChat.modelSelector.unified.recommended');
    expect(marker.parentElement?.textContent).toContain(expected);
  });

  it('refreshes defaults and controls in an open drawer when the catalog changes', () => {
    const { rerender } = draw();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('272');
    rerender(
      drawer({ ...model, contextWindow: 700_000, efforts: ['high', 'max'], defaultEffort: 'max' }),
    );
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('700');
    expect(screen.queryByRole('button', { name: 'effortLevels.low' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'effortLevels.max' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('allows an intentional override above the maximum and rejects invalid input', () => {
    draw();
    const input = screen.getByRole('textbox', {
      name: 'settings.providers.models.advanced.contextLimitAria',
    });
    fireEvent.change(input, { target: { value: '1200' } });
    expect(
      screen.getByText('settings.providers.models.advanced.contextLimitOverWindow'),
    ).toBeTruthy();
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenLastCalledWith(1_200_000);
    fireEvent.change(input, { target: { value: '-1' } });
    fireEvent.blur(input);
    expect(mocks.setLimit).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('shows mixed effort and each engine default without inventing a common selection', () => {
    draw(model, 'low');
    expect(screen.getByText('settings.providers.models.advanced.effortMixed')).toBeTruthy();
    expect(
      screen.getAllByText(/settings.providers.models.advanced.engineDefaultEffort/),
    ).toHaveLength(2);
  });

  it('uses provider-declared image capability ahead of family-name heuristics', () => {
    draw({ ...model, id: 'deepseek-v4', name: 'DeepSeek', supportsImageInput: true });
    expect(screen.getByText('settings.providers.models.advanced.vision.vision')).toBeTruthy();
    expect(screen.getByText('settings.providers.models.advanced.inputModalities')).toBeTruthy();
  });
});
