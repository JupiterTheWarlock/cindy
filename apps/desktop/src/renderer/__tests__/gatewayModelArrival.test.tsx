// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';
import { parseModelsSyncPayload } from '../../main/model-access/modelsSyncRefresh';
import {
  getActiveCatalog,
  setActiveCatalog,
  setActiveCatalogChangedListener,
  setXdGatewayModels,
} from '../../main/maker-host/active-catalog';
import { UnifiedModelList } from '../components/settings/UnifiedModelList';
import { __resetForTest, setModelVisibilityOwner } from '../state/modelVisibilityPrefs';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('../hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));
vi.mock('../components/settings/ModelAdvancedDrawer', () => ({ ModelAdvancedDrawer: () => null }));

afterEach(() => {
  setActiveCatalogChangedListener(null);
  cleanup();
  setXdGatewayModels([]);
  setActiveCatalog(BUNDLED_CATALOG);
  __resetForTest();
});

it('shows a just-downloaded Gateway model through the real parser and active catalog without a registry entry or remount', () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} });
  __resetForTest();
  setModelVisibilityOwner('arrival-test', 1, 'cloud');
  setActiveCatalog(BUNDLED_CATALOG);
  const raw = (id: string, name: string) => ({
    id,
    name,
    currency: 'USD',
    availability: 'available',
    mode: 'chat',
    agents: ['claude-code'],
    contextWindow: 500_000,
    modalities: { input: ['text', 'image'], output: ['text'] },
    efforts: ['low', 'high'],
    defaultEffort: 'high',
    perAgent: { 'claude-code': { wireProtocol: 'anthropic-messages' } },
  });
  const download = (models: ReturnType<typeof raw>[]) => {
    const result = parseModelsSyncPayload({ schemaVersion: 5, accountTier: 'paid', models });
    if (!result.ok) throw new Error(result.error);
    setXdGatewayModels(result.models, { authoritative: true });
  };
  const snapshot = () =>
    ({
      ...getActiveCatalog().providers.find((p) => p.id === 'xd')!,
      connected: true,
      source: 'builtin',
    }) as ProviderView;
  const existing = raw('deepseek/deepseek-current', 'Existing Model');
  download([existing]);
  const view = render(<UnifiedModelList provider={snapshot()} />);
  expect(screen.getByText('Existing Model')).toBeTruthy();
  expect(screen.queryByText('Future Model 9')).toBeNull();
  const changed = vi.fn(() => view.rerender(<UnifiedModelList provider={snapshot()} />));
  setActiveCatalogChangedListener(changed);
  act(() => download([existing, raw('new-labs/future-9', 'Future Model 9')]));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Future Model 9')).toBeTruthy();
  expect(screen.getByText('new-labs')).toBeTruthy();
  expect(screen.getByRole('switch', { name: /Future Model 9/ }).getAttribute('aria-checked')).toBe(
    'true',
  );
  expect(snapshot().models['claude-code']?.find((m) => m.id === 'new-labs/future-9')).toMatchObject(
    {
      contextWindow: 500_000,
      modalities: { input: ['text', 'image'], output: ['text'] },
    },
  );
});
