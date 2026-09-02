import { afterEach, describe, expect, it } from 'vitest';

import {
  BUNDLED_CATALOG,
  buildUserProvider,
  type CustomProviderConfig,
} from '@cindy/model-providers';

import {
  buildCodexImageGenerationProviderArgs,
  codexImageGenerationRouteSignature,
  crossesCodexAppliedImageGenerationIdentity,
  deriveCodexImageGenerationRoutes,
  isCodexImageGenerationNamespacePath,
  parseCodexImageGenerationPath,
  relativeProviderRequestPath,
  resolveCodexImageGenerationProviderId,
  setCodexAppliedImageGenerationRoutes,
} from '../codex-image-generation-route.js';
import { beginProviderRouteMutation } from '../provider-route.js';

function customProvider(overrides: Partial<CustomProviderConfig> = {}) {
  return buildUserProvider({
    id: 'haoplay-local',
    name: 'HaoPlay',
    runtimes: {
      codex: {
        baseUrl: 'https://provider.example/v1',
        requestPath: '/v1/responses',
        wireProtocol: 'openai-responses',
        supportsImageGeneration: true,
        models: [
          { id: 'chat-image', name: 'Chat Image' },
          { id: 'chat-image-alt', name: 'Chat Image Alt' },
          {
            id: 'chat-text',
            name: 'Chat Text',
            supportsImageInput: true,
            route: {
              baseUrl: 'https://provider.example/v1',
              wireProtocol: 'openai-chat',
            },
          },
        ],
      },
    },
    ...overrides,
  });
}

function catalog(provider = customProvider()) {
  return { ...BUNDLED_CATALOG, providers: [...BUNDLED_CATALOG.providers, provider] };
}

afterEach(() => {
  setCodexAppliedImageGenerationRoutes([]);
});

describe('Codex custom Provider image-generation identity', () => {
  it('derives one stable identity per enabled Provider for every eligible Responses model', () => {
    const routes = deriveCodexImageGenerationRoutes(catalog());
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      providerId: 'haoplay-local',
      supportedModels: ['chat-image', 'chat-image-alt'],
    });
    expect(routes[0]?.modelProviderId).toMatch(/^cindy_imagegen_[a-f0-9]{20}$/);
    expect(resolveCodexImageGenerationProviderId(routes, 'haoplay-local', 'chat-image')).toBe(
      routes[0]?.modelProviderId,
    );
    expect(resolveCodexImageGenerationProviderId(routes, 'haoplay-local', 'chat-image-alt')).toBe(
      routes[0]?.modelProviderId,
    );
    expect(resolveCodexImageGenerationProviderId(routes, 'haoplay-local', 'chat-text')).toBeNull();

    const disabled = customProvider({
      runtimes: {
        codex: {
          baseUrl: 'https://provider.example/v1',
          wireProtocol: 'openai-responses',
          models: [{ id: 'vision-input', name: 'Vision Input', supportsImageInput: true }],
        },
      },
    });
    expect(deriveCodexImageGenerationRoutes(catalog(disabled))).toEqual([]);
  });

  it('uses the applied Host snapshot to identify only real dynamic identity crossings', () => {
    const routeA = deriveCodexImageGenerationRoutes(catalog())[0]!;
    const routeB = deriveCodexImageGenerationRoutes(
      catalog(customProvider({ id: 'provider-b', name: 'Provider B' })),
    )[0]!;
    setCodexAppliedImageGenerationRoutes([routeA, routeB]);
    const base = {
      agentKind: 'codex',
      remoteHostId: null,
      currentCodexProxyActive: true,
      currentThreadModelProviderId: routeA.modelProviderId,
    };

    expect(
      crossesCodexAppliedImageGenerationIdentity({
        ...base,
        targetProviderId: routeA.providerId,
        targetModel: 'chat-image-alt',
      }),
    ).toBe(false);
    expect(
      crossesCodexAppliedImageGenerationIdentity({
        ...base,
        targetProviderId: routeA.providerId,
        targetModel: 'chat-text',
      }),
    ).toBe(true);
    expect(
      crossesCodexAppliedImageGenerationIdentity({
        ...base,
        currentThreadModelProviderId: 'cindy_gateway',
        targetProviderId: routeA.providerId,
        targetModel: 'chat-image',
      }),
    ).toBe(true);
    expect(
      crossesCodexAppliedImageGenerationIdentity({
        ...base,
        targetProviderId: routeB.providerId,
        targetModel: 'chat-image',
      }),
    ).toBe(true);
    expect(
      crossesCodexAppliedImageGenerationIdentity({
        ...base,
        currentThreadModelProviderId: 'cindy_gateway',
        targetProviderId: 'ordinary-provider',
        targetModel: 'ordinary-model',
      }),
    ).toBe(false);
  });

  it('keeps the identity stable while including capability changes in the host snapshot', () => {
    const before = deriveCodexImageGenerationRoutes(catalog())[0]!;
    const changed = customProvider({
      runtimes: {
        codex: {
          baseUrl: 'https://other.example/openai',
          wireProtocol: 'openai-responses',
          supportsImageGeneration: true,
          models: [{ id: 'new-image', name: 'New Image' }],
        },
      },
    });
    const afterCatalog = catalog(changed);
    const after = deriveCodexImageGenerationRoutes(afterCatalog)[0]!;
    expect(after.modelProviderId).toBe(before.modelProviderId);
    expect(codexImageGenerationRouteSignature(afterCatalog)).not.toBe(
      codexImageGenerationRouteSignature(catalog()),
    );
  });

  it('builds actor-gated loopback config without upstream URLs or user credentials', () => {
    const route = deriveCodexImageGenerationRoutes(catalog())[0]!;
    const config = buildCodexImageGenerationProviderArgs('http://127.0.0.1:43210', 'oauth-bearer', [
      route,
    ]);
    const argv = config.extraArgs.join(' ');
    expect(argv).toContain(
      `model_providers.${route.modelProviderId}.name="Cindy Image Generation"`,
    );
    expect(argv).toContain('x-openai-actor-authorization = "local-image-extension"');
    expect(argv).toContain('supports_websockets=false');
    expect(argv).toContain(`/_cindy/imagegen/${route.routeId}`);
    expect(argv).not.toContain('provider.example');
    expect(argv).not.toContain('haoplay-local');
    expect(config.extraEnv.XDT_CODEX_API_KEY).toBeTruthy();
  });

  it('keeps custom header credentials out of the Host snapshot and signature input', () => {
    const secret = 'Bearer fake-vendor-secret';
    const provider = customProvider({
      runtimes: {
        codex: {
          baseUrl: 'https://provider.example/v1',
          wireProtocol: 'openai-responses',
          supportsImageGeneration: true,
          headers: { Authorization: secret, 'x-vendor-token': 'fake-token' },
          models: [{ id: 'chat-image', name: 'Chat Image' }],
        },
      },
    });
    const route = deriveCodexImageGenerationRoutes(catalog(provider))[0]!;
    expect(JSON.stringify(route)).not.toContain(secret);
    expect(JSON.stringify(route)).not.toContain('fake-token');
    expect(route.routing.headerOverride).toBeUndefined();

    const before = codexImageGenerationRouteSignature(catalog(provider));
    const mutation = beginProviderRouteMutation(provider.id);
    mutation.commit();
    mutation();
    const after = codexImageGenerationRouteSignature(catalog(provider));
    expect(after).not.toBe(before);
    expect(after).not.toContain(secret);
  });

  it('parses only the dedicated route and strips the prefix completely', () => {
    const routeId = 'a'.repeat(20);
    expect(parseCodexImageGenerationPath(`/_cindy/imagegen/${routeId}/responses?x=1`)).toEqual({
      kind: 'route',
      routeId,
      upstreamPath: '/responses?x=1',
      pathKind: 'responses',
    });
    expect(parseCodexImageGenerationPath(`/_cindy/imagegen/${routeId}/images/generations`)).toEqual(
      {
        kind: 'route',
        routeId,
        upstreamPath: '/images/generations',
        pathKind: 'images',
      },
    );
    expect(parseCodexImageGenerationPath(`/_cindy/imagegen/${routeId}/images/edits`)).toEqual({
      kind: 'route',
      routeId,
      upstreamPath: '/images/edits',
      pathKind: 'images',
    });
    expect(parseCodexImageGenerationPath('/v1/images/generations')).toEqual({
      kind: 'not-image-generation-route',
    });
  });

  it('claims raw private namespace variants before normalization and rejects non-canonical paths', () => {
    const routeId = 'a'.repeat(20);
    const invalid = [
      '/_cindy/imagegen',
      '/_cindy/imagegen/',
      '/_cindy/imagegen//',
      '/_cindy/imagegen/../responses',
      '/_cindy/imagegen/%2e%2e/responses',
      '/_CINDY/IMAGEGEN/' + routeId + '/responses',
      '/_%63indy/image%67en/' + routeId + '/responses',
      '/_cindy/imagegen%2f' + routeId + '/responses',
      '/_cindy/imagegen%5c' + routeId + '/responses',
      '/_cindy/imagegen/' + routeId + '/images/edits/extra',
      '/_cindy/imagegen/' + routeId + '/images/edits#fragment',
      'https://localhost/_cindy/imagegen/../responses',
    ];
    for (const path of invalid) {
      expect(isCodexImageGenerationNamespacePath(path), path).toBe(true);
      expect(parseCodexImageGenerationPath(path), path).toEqual({ kind: 'invalid' });
    }
    expect(isCodexImageGenerationNamespacePath('/v1/not-imagegen/responses')).toBe(false);
  });

  it('uses chat requestPath without duplicating an upstream /v1 base path', () => {
    expect(relativeProviderRequestPath('https://provider.example/v1', '/v1/responses')).toBe(
      '/responses',
    );
    expect(relativeProviderRequestPath('https://provider.example/v1/', '/responses')).toBe(
      '/responses',
    );
    expect(relativeProviderRequestPath('https://provider.example/v1', '//evil')).toBeNull();
  });
});
