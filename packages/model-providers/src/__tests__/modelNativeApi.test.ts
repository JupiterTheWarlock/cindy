import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, type ModelRegistry } from '../index.js';
import { parseModelRegistry } from '../modelAccessValidator.js';
import { resolveModelNativeApi } from '../modelRegistry.js';

const registry = (): ModelRegistry => ({
  schemaVersion: 3,
  updatedAt: '2026-09-05T00:00:00.000Z',
  models: [],
  nativeApiRules: [
    { providerId: 'xd', modelIdPrefix: 'google/gemini-', nativeApi: 'google-generative-ai' },
  ],
});

describe('canonical model APIs in registry v3', () => {
  it('validates the complete bundled snapshot and keeps legacy versions readable', () => {
    expect(parseModelRegistry(BUNDLED_CATALOG.modelRegistry).ok).toBe(true);
    for (const schemaVersion of [1, 2])
      expect(
        parseModelRegistry({ schemaVersion, updatedAt: registry().updatedAt, models: [] }).ok,
      ).toBe(true);
    expect(parseModelRegistry({ ...registry(), schemaVersion: 2 }).ok).toBe(false);
    expect(
      parseModelRegistry({
        ...registry(),
        nativeApiRules: [
          { providerId: 'xd', modelIdPrefix: '', nativeApi: 'google-generative-ai' },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseModelRegistry({
        ...registry(),
        nativeApiRules: [...registry().nativeApiRules!, ...registry().nativeApiRules!],
      }).ok,
    ).toBe(false);
  });
  it('resolves new models by route-scoped rule without inventing other provider identities', () => {
    expect(resolveModelNativeApi(registry(), 'xd', 'google/gemini-99-pro[1m]')).toBe(
      'google-generative-ai',
    );
    expect(resolveModelNativeApi(registry(), 'other', 'google/gemini-99-pro')).toBeUndefined();
    expect(resolveModelNativeApi(registry(), 'xd', 'google/gemini-99/other')).toBeUndefined();
  });
  it('honors an exact correction, explicit unknown, and retirement before family defaults', () => {
    const r = registry();
    r.models = [
      {
        id: 'google/new',
        name: 'New',
        nativeApi: 'openai-responses',
        routes: [{ providerId: 'xd', modelId: 'google/gemini-new', agents: ['codex'] }],
      },
    ];
    expect(parseModelRegistry(r).ok).toBe(true);
    expect(resolveModelNativeApi(r, 'xd', 'google/gemini-new')).toBe('openai-responses');
    r.models[0].nativeApi = null;
    expect(resolveModelNativeApi(r, 'xd', 'google/gemini-new')).toBeNull();
    delete r.models[0].nativeApi;
    r.models[0].status = 'retired';
    expect(resolveModelNativeApi(r, 'xd', 'google/gemini-new')).toBeNull();
  });
  it('rejects unrecognized protocol values instead of silently using a compatibility route', () => {
    const r = registry();
    expect(
      parseModelRegistry({
        ...r,
        nativeApiRules: [{ ...r.nativeApiRules![0], nativeApi: 'future-api' }],
      }).ok,
    ).toBe(false);
    expect(
      parseModelRegistry({
        ...r,
        models: [{ id: 'm', name: 'M', routes: [], nativeApi: 'future-api' }],
      }).ok,
    ).toBe(false);
  });
});
