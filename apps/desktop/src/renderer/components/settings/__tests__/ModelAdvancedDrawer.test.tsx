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
function draw(primary = model, bridgeDefault = primary.defaultEffort) {
  const row = {
    id: primary.id,
    name: primary.name,
    avail: ['codex', 'claude-code'] as ('codex' | 'claude-code')[],
    byAgent: {
      codex: primary,
      'claude-code': { ...primary, id: `chatgpt/${primary.id}`, defaultEffort: bridgeDefault },
    },
  };
  return render(
    <ModelAdvancedDrawer
      provider={provider}
      row={row}
      open
      onOpenChange={vi.fn()}
      pricePresentationOf={() => null}
      onDisable={vi.fn()}
      disabled={false}
      paymentRequired={false}
    />,
  );
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
