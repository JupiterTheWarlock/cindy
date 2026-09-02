import { createHash } from 'node:crypto';

import type { Catalog, Provider, RoutingDescriptor } from '@cindy/model-providers';
import { storedCustomProviderId } from '@cindy/model-providers';

import {
  CODEX_GATEWAY_ENV_KEY,
  CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY,
  type CodexProxySpawnAuthMode,
} from './codex-gateway-config.js';
import { getProviderRouteCredentialRevision } from './provider-route.js';

export const CODEX_IMAGE_GENERATION_ACTOR_HEADER = 'x-openai-actor-authorization';
export const CODEX_IMAGE_GENERATION_ACTOR_VALUE = 'local-image-extension';
export const CODEX_IMAGE_GENERATION_ROUTE_ROOT = '/_cindy/imagegen';

export interface CodexImageGenerationRoute {
  /** Runtime catalog id (legacy xAI rows may be projected as custom:xai). */
  providerId: string;
  /** Stable, non-sensitive handle derived only from the stored custom Provider id. */
  routeId: string;
  modelProviderId: string;
  supportedModels: readonly string[];
  /** Host-spawn snapshot used only inside Desktop's loopback routing boundary. */
  routing: RoutingDescriptor;
  /** Per-model Responses routes frozen with the same Host snapshot. */
  responseRoutingByModel: Readonly<Record<string, RoutingDescriptor>>;
  /** Non-sensitive credential generation frozen with this Host snapshot. */
  credentialRevision: number;
}

/** Routes actually frozen into the currently running local Codex Host. */
let appliedImageGenerationRoutes: readonly CodexImageGenerationRoute[] = [];

export function setCodexAppliedImageGenerationRoutes(
  routes: readonly CodexImageGenerationRoute[],
): void {
  appliedImageGenerationRoutes = [...routes];
}

export function findCodexAppliedImageGenerationRoute(
  routeId: string,
): CodexImageGenerationRoute | undefined {
  return appliedImageGenerationRoutes.find((route) => route.routeId === routeId);
}

export function hasCodexAppliedImageGenerationProvider(providerId: string): boolean {
  const storedProviderId = storedCustomProviderId(providerId);
  return appliedImageGenerationRoutes.some(
    (route) => storedCustomProviderId(route.providerId) === storedProviderId,
  );
}

function stableRouteId(providerId: string): string {
  return createHash('sha256').update(providerId, 'utf8').digest('hex').slice(0, 20);
}

function effectiveModelWireProtocol(
  model: { route?: { wireProtocol: string } },
  routing: RoutingDescriptor,
): string {
  return model.route?.wireProtocol ?? routing.wireProtocol ?? 'openai-responses';
}

function frozenRoutingDescriptor(routing: RoutingDescriptor): RoutingDescriptor {
  const frozen = { ...routing };
  // Custom headers are credentials. Keep only their non-sensitive availability state in the Host
  // snapshot; values are read at request time behind provider-route's credential generation gate.
  delete frozen.headerOverride;
  return frozen;
}

function routeForProvider(provider: Provider): CodexImageGenerationRoute | null {
  if (provider.source !== 'user' || !provider.agents.includes('codex')) return null;
  const routing = provider.routing.codex;
  if (!routing || routing.disabled || routing.supportsImageGeneration !== true) return null;
  const supported = (provider.models.codex ?? []).filter(
    (model) => effectiveModelWireProtocol(model, routing) === 'openai-responses',
  );
  const supportedModels = supported.map((model) => model.id);
  if (supportedModels.length === 0) return null;
  const routeId = stableRouteId(storedCustomProviderId(provider.id));
  const frozenRouting = frozenRoutingDescriptor(routing);
  return {
    providerId: provider.id,
    routeId,
    modelProviderId: `cindy_imagegen_${routeId}`,
    supportedModels,
    credentialRevision: getProviderRouteCredentialRevision(provider.id),
    routing: frozenRouting,
    responseRoutingByModel: Object.fromEntries(
      supported.map((model) => {
        if (!model.route) return [model.id, { ...frozenRouting }];
        const inherited = { ...frozenRouting };
        delete inherited.requestPath;
        return [
          model.id,
          {
            ...inherited,
            upstream: model.route.baseUrl,
            wireProtocol: model.route.wireProtocol,
            ...(model.route.requestPath ? { requestPath: model.route.requestPath } : {}),
          },
        ];
      }),
    ),
  };
}

/** Strip Desktop-only routing data before the snapshot crosses into maker-core. */
export function toCodexImageGenerationHostRoutes(
  routes: readonly CodexImageGenerationRoute[],
): Array<Pick<CodexImageGenerationRoute, 'providerId' | 'modelProviderId' | 'supportedModels'>> {
  return routes.map(({ providerId, modelProviderId, supportedModels }) => ({
    providerId,
    modelProviderId,
    supportedModels: [...supportedModels],
  }));
}

export function deriveCodexImageGenerationRoutes(catalog: Catalog): CodexImageGenerationRoute[] {
  return catalog.providers.flatMap((provider) => {
    const route = routeForProvider(provider);
    return route ? [route] : [];
  });
}

export function codexImageGenerationRouteSignature(catalog: Catalog): string {
  const snapshot = deriveCodexImageGenerationRoutes(catalog)
    .map((route) => ({
      providerId: route.providerId,
      modelProviderId: route.modelProviderId,
      supportedModels: [...route.supportedModels].sort(),
      routing: route.routing,
      responseRoutingByModel: route.responseRoutingByModel,
      credentialRevision: route.credentialRevision,
    }))
    .sort((left, right) => left.modelProviderId.localeCompare(right.modelProviderId));
  return snapshot.length === 0
    ? ''
    : createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
}

export function resolveCodexImageGenerationProviderId(
  routes: readonly CodexImageGenerationRoute[],
  providerId: string | null | undefined,
  model: string | null | undefined,
): string | null {
  if (!providerId || !model) return null;
  const route = routes.find((candidate) => candidate.providerId === providerId);
  return route?.supportedModels.includes(model) ? route.modelProviderId : null;
}

export interface CodexAppliedImageGenerationIdentityInput {
  agentKind: string;
  remoteHostId?: string | null;
  currentCodexProxyActive?: boolean | null;
  currentThreadModelProviderId?: string | null;
  targetProviderId?: string | null;
  targetModel?: string | null;
}

/**
 * Whether a local Codex thread would cross the image-generation identity frozen into its Host.
 * Membership in the applied snapshot is the authority: do not infer private identities from ids.
 */
export function crossesCodexAppliedImageGenerationIdentity(
  input: CodexAppliedImageGenerationIdentityInput,
): boolean {
  if (input.agentKind !== 'codex' || input.remoteHostId || input.currentCodexProxyActive !== true) {
    return false;
  }

  const actual = input.currentThreadModelProviderId?.trim() || null;
  const target = resolveCodexImageGenerationProviderId(
    appliedImageGenerationRoutes,
    input.targetProviderId?.trim() || null,
    input.targetModel?.trim() || null,
  );
  const actualIsAppliedImageGenerationIdentity = appliedImageGenerationRoutes.some(
    (route) => route.modelProviderId === actual,
  );

  return target !== null ? actual !== target : actualIsAppliedImageGenerationIdentity;
}

export function buildCodexImageGenerationProviderArgs(
  proxyEndpoint: string,
  authMode: CodexProxySpawnAuthMode,
  routes: readonly CodexImageGenerationRoute[],
): { extraArgs: string[]; extraEnv: Record<string, string> } {
  const endpoint = proxyEndpoint.replace(/\/+$/, '');
  const extraArgs: string[] = [];
  for (const route of routes) {
    const baseUrl = `${endpoint}${CODEX_IMAGE_GENERATION_ROUTE_ROOT}/${route.routeId}`;
    const p = route.modelProviderId;
    extraArgs.push(
      '-c',
      `model_providers.${p}.name="Cindy Image Generation"`,
      '-c',
      `model_providers.${p}.base_url="${baseUrl}"`,
      '-c',
      `model_providers.${p}.wire_api="responses"`,
      '-c',
      `model_providers.${p}.env_key="${CODEX_GATEWAY_ENV_KEY}"`,
      '-c',
      `model_providers.${p}.supports_websockets=false`,
      '-c',
      `model_providers.${p}.http_headers={ ${CODEX_IMAGE_GENERATION_ACTOR_HEADER} = "${CODEX_IMAGE_GENERATION_ACTOR_VALUE}" }`,
    );
  }
  return {
    extraArgs,
    // OAuth hosts normally do not need the gateway env key. Dynamic custom identities do:
    // the value is only a loopback placeholder and is replaced by the Provider route boundary.
    extraEnv:
      authMode === 'oauth-bearer'
        ? { [CODEX_GATEWAY_ENV_KEY]: CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY }
        : {},
  };
}

export type ParsedCodexImageGenerationPath =
  | { kind: 'not-image-generation-route' }
  | { kind: 'invalid' }
  | { kind: 'route'; routeId: string; upstreamPath: string; pathKind: 'responses' | 'images' };

interface RawRequestTarget {
  pathname: string;
  search: string;
  hasFragment: boolean;
}

/** Split origin-form or absolute-form HTTP request targets without URL normalization/decoding. */
function splitRawRequestTarget(rawUrl: string): RawRequestTarget | null {
  let target = rawUrl;
  const absoluteMatch = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(target);
  if (absoluteMatch) {
    const authorityStart = absoluteMatch[0].length;
    const pathStart = target.slice(authorityStart).search(/[/?#\\]/);
    if (pathStart < 0) return { pathname: '/', search: '', hasFragment: false };
    target = target.slice(authorityStart + pathStart);
    if (!target.startsWith('/')) target = `/${target}`;
  }
  if (!target.startsWith('/')) return null;
  const fragmentIndex = target.indexOf('#');
  const beforeFragment = fragmentIndex < 0 ? target : target.slice(0, fragmentIndex);
  const queryIndex = beforeFragment.indexOf('?');
  return {
    pathname: queryIndex < 0 ? beforeFragment : beforeFragment.slice(0, queryIndex),
    search: queryIndex < 0 ? '' : beforeFragment.slice(queryIndex),
    hasFragment: fragmentIndex >= 0,
  };
}

function decodePercentBytesForOwnership(pathname: string): string {
  return pathname.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function beginsWithImageGenerationNamespace(segments: readonly string[]): boolean {
  return segments[0] === '_cindy' && segments[1] === 'imagegen';
}

/**
 * Match ownership of the private loopback namespace before content-type parsing.
 * Encoded slashes deliberately count as owned-but-invalid so they can never fall through to the
 * default Gateway/ChatGPT route.
 */
export function isCodexImageGenerationNamespacePath(rawUrl: string): boolean {
  const target = splitRawRequestTarget(rawUrl);
  if (!target) return false;
  const decoded = decodePercentBytesForOwnership(target.pathname).replace(/\\/g, '/').toLowerCase();
  const lexicalSegments = decoded.split('/').filter((segment) => segment && segment !== '.');
  if (beginsWithImageGenerationNamespace(lexicalSegments)) return true;

  const semanticSegments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') semanticSegments.pop();
    else semanticSegments.push(segment);
  }
  return beginsWithImageGenerationNamespace(semanticSegments);
}

export function parseCodexImageGenerationPath(rawUrl: string): ParsedCodexImageGenerationPath {
  const owned = isCodexImageGenerationNamespacePath(rawUrl);
  const target = splitRawRequestTarget(rawUrl);
  if (!target || target.hasFragment) {
    return owned ? { kind: 'invalid' } : { kind: 'not-image-generation-route' };
  }
  const { pathname, search } = target;
  if (!pathname.startsWith(`${CODEX_IMAGE_GENERATION_ROUTE_ROOT}/`)) {
    return isCodexImageGenerationNamespacePath(rawUrl)
      ? { kind: 'invalid' }
      : { kind: 'not-image-generation-route' };
  }
  const rest = pathname.slice(CODEX_IMAGE_GENERATION_ROUTE_ROOT.length + 1);
  const slash = rest.indexOf('/');
  if (slash <= 0) return { kind: 'invalid' };
  const routeId = rest.slice(0, slash);
  const upstreamPath = rest.slice(slash);
  if (!/^[a-f0-9]{20}$/.test(routeId)) return { kind: 'invalid' };
  const pathKind =
    upstreamPath === '/responses'
      ? 'responses'
      : upstreamPath === '/images/generations' || upstreamPath === '/images/edits'
        ? 'images'
        : null;
  if (!pathKind) return { kind: 'invalid' };
  return { kind: 'route', routeId, upstreamPath: `${upstreamPath}${search}`, pathKind };
}

/** Convert an absolute Provider requestPath into a path relative to its upstream base. */
export function relativeProviderRequestPath(upstream: string, requestPath: string): string | null {
  let basePath: string;
  try {
    basePath = new URL(upstream).pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
  const queryIndex = requestPath.indexOf('?');
  const pathname = queryIndex >= 0 ? requestPath.slice(0, queryIndex) : requestPath;
  const query = queryIndex >= 0 ? requestPath.slice(queryIndex) : '';
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return null;
  if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
    return `${pathname.slice(basePath.length) || '/'}${query}`;
  }
  return requestPath;
}
