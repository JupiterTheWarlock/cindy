import type { CatalogModel } from '@cindy/model-providers';
import type { ProviderLogoKind } from '@cindy/model-providers/branding';

export interface ModelBrand {
  key: string;
  label: string;
  logoKind?: ProviderLogoKind;
}

const brands: Record<string, ModelBrand> = {
  anthropic: { key: 'anthropic', label: 'Anthropic', logoKind: 'anthropic' },
  openai: { key: 'openai', label: 'OpenAI', logoKind: 'openai' },
  google: { key: 'google', label: 'Google', logoKind: 'google' },
  deepseek: { key: 'deepseek', label: 'DeepSeek', logoKind: 'deepseek' },
  qwen: { key: 'qwen', label: 'Qwen', logoKind: 'alibaba' },
  moonshot: { key: 'moonshot', label: 'Moonshot', logoKind: 'moonshot' },
  zai: { key: 'zai', label: 'Z.ai', logoKind: 'zai' },
  tencent: { key: 'tencent', label: 'Tencent', logoKind: 'tencentcloud' },
  meta: { key: 'meta', label: 'Meta' },
  xai: { key: 'xai', label: 'xAI', logoKind: 'xai' },
  minimax: { key: 'minimax', label: 'MiniMax', logoKind: 'minimax' },
  bytedance: { key: 'bytedance', label: 'ByteDance', logoKind: 'volcengine' },
  alibaba: { key: 'alibaba', label: 'Alibaba', logoKind: 'alibaba' },
  elevenlabs: { key: 'elevenlabs', label: 'ElevenLabs' },
  voyage: { key: 'voyage', label: 'Voyage' },
};

const namespaces: Record<string, string> = {
  'anthropic-claude': 'anthropic',
  chatgpt: 'openai',
  codex: 'openai',
  moonshotai: 'moonshot',
  'z-ai': 'zai',
  'x-ai': 'xai',
  'x-ai-grok': 'xai',
  'bytedance-seed': 'bytedance',
};

/** Display identity only. Never use these labels to merge IDs, select a route or infer capabilities. */
export function modelBrand(model: Pick<CatalogModel, 'id'>): ModelBrand | undefined {
  const id = model.id.toLowerCase();
  const slash = id.indexOf('/');
  if (slash > 0) {
    const namespace = id.slice(0, slash);
    const key = Object.hasOwn(namespaces, namespace) ? namespaces[namespace]! : namespace;
    const known = Object.hasOwn(brands, key) ? brands[key] : undefined;
    return known ?? { key: `namespace:${namespace}`, label: model.id.slice(0, slash) };
  }
  const families: Array<[RegExp, string]> = [
    [/^claude-/, 'anthropic'],
    [/^(?:gpt-|o[134](?:-|$))/, 'openai'],
    [/^gemini-/, 'google'],
    [/^deepseek-/, 'deepseek'],
    [/^qwen(?:\d|[-/])/, 'qwen'],
    [/^glm-/, 'zai'],
    [/^kimi-/, 'moonshot'],
    [/^grok-/, 'xai'],
    [/^hy\d/, 'tencent'],
    [/^(?:seedream|seedance|doubao-)/, 'bytedance'],
  ];
  return brands[families.find(([pattern]) => pattern.test(id))?.[1] ?? ''];
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
function normalizedName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/([a-z])(?=\d)/gi, '$1 ')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Family names A–Z; numeric model versions descending within a family. This is NOT release order. */
export function compareModelNames(
  a: Pick<CatalogModel, 'id' | 'name'>,
  b: Pick<CatalogModel, 'id' | 'name'>,
): number {
  const an = normalizedName(a.name);
  const bn = normalizedName(b.name);
  const family = (name: string) => name.split(/\d/, 1)[0]!.trim();
  return (
    collator.compare(family(an), family(bn)) ||
    collator.compare(bn, an) ||
    collator.compare(a.id, b.id)
  );
}

export const MANAGEMENT_KIND_ORDER = [
  'chat',
  'image',
  'video',
  'tts',
  'stt',
  'realtime',
  'embedding',
  'compression',
  'other',
] as const;
export type ManagementKind = (typeof MANAGEMENT_KIND_ORDER)[number];
export type ManagementView = 'brand' | 'model';

export function groupModelsForManagement<T extends Pick<CatalogModel, 'id' | 'name'>>(
  models: readonly T[],
  view: ManagementView,
  kindOf: (model: T) => ManagementKind,
): Array<{ key: string; kind: ManagementKind; brand?: ModelBrand; models: T[] }> {
  const groups = new Map<
    string,
    { key: string; kind: ManagementKind; brand?: ModelBrand; models: T[] }
  >();
  for (const model of models) {
    const kind = kindOf(model);
    const brand = view === 'brand' && kind === 'chat' ? modelBrand(model) : undefined;
    const key = brand ? `${kind}:${brand.key}` : kind;
    let group = groups.get(key);
    if (!group) {
      group = { key, kind, ...(brand ? { brand } : {}), models: [] };
      groups.set(key, group);
    }
    group.models.push(model);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        MANAGEMENT_KIND_ORDER.indexOf(a.kind) - MANAGEMENT_KIND_ORDER.indexOf(b.kind) ||
        (a.brand
          ? b.brand
            ? collator.compare(a.brand.label, b.brand.label)
            : -1
          : b.brand
            ? 1
            : 0),
    )
    .map((group) => ({ ...group, models: [...group.models].sort(compareModelNames) }));
}

/** Only annotate collisions; labels retain exact routing namespaces, without claiming billing mode. */
export function modelRouteLabels(
  models: readonly Pick<CatalogModel, 'id' | 'name'>[],
): Map<string, string> {
  const byName = new Map<string, Array<Pick<CatalogModel, 'id' | 'name'>>>();
  for (const model of models) {
    const key = normalizedName(model.name);
    const list = byName.get(key) ?? [];
    list.push(model);
    byName.set(key, list);
  }
  const result = new Map<string, string>();
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    const namespace = (id: string) => (id.includes('/') ? id.slice(0, id.indexOf('/')) : id);
    for (const model of list) {
      const short = namespace(model.id);
      result.set(
        model.id,
        list.filter((other) => namespace(other.id) === short).length > 1 ? model.id : short,
      );
    }
  }
  return result;
}
