/**
 * Match the model name a provider SDK reports to a key in the pricing table.
 *
 * Names are compared by their base name: lower-cased, without the provider path
 * (groq/openai/gpt-oss-120b -> gpt-oss-120b), a Bedrock region (us.), or a date or
 * -latest suffix. Among keys with the same base name, the span's vendor's own key wins
 * (its key for the exact dated version first), then the key for the exact name, then the
 * shortest key. A name with no matching base name gets no price, and neither does a call from
 * a strict vendor (Groq) whose own keys do not have it.
 *
 * Port of traccia-py pricing_matcher.py (also copied in traccia-dashboard-service as
 * app/services/pricing/matcher.py). All three run the shared cases in
 * src/__tests__/fixtures/pricing_match_cases.json, so keep them in step.
 */

const REGION = /^(?:us|eu|apac|au|ca|jp|global|us-gov)\./;
const SUFFIX = /(?:-\d{4}-\d{2}-\d{2}|-\d{8}|-latest)$/;

// llm.vendor values whose pricing providers have another name. Any other vendor is
// its own provider family. A family is the provider of that name plus its variants
// after "_" or "-": bedrock -> bedrock_converse, vertex_ai -> vertex_ai-language-models.
const VENDOR_PROVIDERS: Record<string, string[]> = {
  openai: ['openai', 'text-completion-openai'],
  azure_openai: ['azure'],
  google_gemini: ['gemini'],
  google: ['vertex_ai'], // LangChain Vertex AI models
  aws: ['bedrock'], // LangChain Bedrock models
};

// llm.vendor values set only by a provider's own SDK, which calls no other provider (the openai
// SDK also calls OpenAI-compatible providers, so "openai" is not one). Their calls are priced
// only from that provider's keys, never from another provider's key for the same model name.
// The SDKs' cost engines apply the same rule (STRICT_VENDORS).
export const STRICT_VENDORS: ReadonlySet<string> = new Set(['groq']);

// First-party names the pricing table lists only under a dated key (the same as cost-resolver's
// MODEL_ALIASES). Looked up by nameOf; a target missing from the table changes nothing.
const MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'claude-3-opus': 'claude-3-opus-20240229',
  'claude-3-opus-latest': 'claude-3-opus-20240229',
  'claude-3-haiku': 'claude-3-haiku-20240307',
  'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
  'claude-3-5-haiku-latest': 'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-latest': 'claude-3-5-sonnet-20241022',
  'claude-3-7-sonnet': 'claude-3-7-sonnet-20250219',
  'claude-3-7-sonnet-latest': 'claude-3-7-sonnet-20250219',
  'claude-sonnet-4': 'claude-sonnet-4-20250514',
  'claude-sonnet-4-0': 'claude-sonnet-4-20250514',
  'claude-opus-4': 'claude-opus-4-20250514',
  'claude-opus-4-0': 'claude-opus-4-20250514',
});

export interface PriceMatch {
  key: string;
  kind: 'exact' | 'base';
  /** Pricing provider of the key ("" when unknown). */
  provider: string;
  /** A base match the vendor did not settle, among keys of several providers. */
  ambiguous: boolean;
}

type Table = Record<string, unknown>;

/**
 * Lower-cased, without the provider path or region; the date is kept. An OpenAI fine-tune
 * (ft:<base>:<org>:<suffix>:<id>) is named ft:<base>.
 */
export function nameOf(name: string): string {
  const tail = name.trim().toLowerCase().split('/').pop() ?? '';
  const named = tail.replace(REGION, '');
  return named.startsWith('ft:') ? named.split(':').slice(0, 2).join(':') : named;
}

export function baseName(name: string): string {
  return nameOf(name).replace(SUFFIX, '');
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key) as boolean;
}

export function providerOf(key: string, entry: unknown): string {
  let provider =
    entry && typeof entry === 'object' ? (entry as { _provider?: unknown })._provider : undefined;
  if (!provider && key.includes('/')) {
    provider = key.split('/', 1)[0];
  }
  return String(provider || '').toLowerCase();
}

export function vendorProviders(vendor: string | null | undefined): string[] {
  const v = String(vendor || '').trim().toLowerCase();
  if (!v) return [];
  return Object.prototype.hasOwnProperty.call(VENDOR_PROVIDERS, v) ? VENDOR_PROVIDERS[v] : [v];
}

export function inFamily(provider: string, families: string[]): boolean {
  return families.some(
    (f) => provider === f || provider.startsWith(`${f}_`) || provider.startsWith(`${f}-`),
  );
}

// Base name -> keys, per table. Rebuilt when the table's size changes. Counting a table's keys
// is O(n) in JavaScript (len() is O(1) in Python), so a frozen table, which cannot change, is
// not recounted.
const indexes = new WeakMap<Table, { size: number; index: Map<string, string[]> }>();

function indexFor(table: Table): Map<string, string[]> {
  const cached = indexes.get(table);
  if (cached && Object.isFrozen(table)) {
    return cached.index;
  }
  const keys = Object.keys(table);
  if (cached && cached.size === keys.length) {
    return cached.index;
  }
  const index = new Map<string, string[]>();
  for (const key of keys) {
    const base = baseName(key);
    const bucket = index.get(base);
    if (bucket) bucket.push(key);
    else index.set(base, [key]);
  }
  indexes.set(table, { size: keys.length, index });
  return index;
}

/** Every key `model` could be priced from (all keys with its base name). */
export function candidateKeys(model: string | null | undefined, table: Table | null | undefined): string[] {
  if (!model || !table || !String(model).trim()) {
    return [];
  }
  const base = baseName(String(model));
  // The index can be stale for a table edited in place without changing size.
  return base ? (indexFor(table).get(base) ?? []).filter((k) => hasOwn(table, k)) : [];
}

/** Return the pricing key for `model`, or undefined. `vendor` is the span's llm.vendor. */
export function matchModel(
  model: string | null | undefined,
  table: Table | null | undefined,
  vendor?: string | null,
): PriceMatch | undefined {
  const keys = candidateKeys(model, table);
  const named = model && String(model).trim() ? nameOf(String(model)) : '';
  const alias = hasOwn(MODEL_ALIASES, named) ? MODEL_ALIASES[named] : undefined;
  if (alias !== undefined && table && hasOwn(table, alias) && !keys.includes(alias)) {
    keys.push(alias);
  }
  if (!keys.length || !table) {
    return undefined;
  }
  const name = String(model);
  const wanted = nameOf(name);
  const providers = vendorProviders(vendor);
  const own = (key: string): boolean => inFamily(providerOf(key, table[key]), providers);
  // Same order as the Python sort key: (not own, not exact, not alias, not same name, length,
  // key). The vendor's own keys first; then the exact key, the alias target, a key for the
  // exact name (with its date or -latest), and the shortest key, also when the vendor has no
  // key of its own.
  const rank = (key: string): Array<number | string> => [
    own(key) ? 0 : 1,
    key === name ? 0 : 1,
    key === alias ? 0 : 1,
    nameOf(key) === wanted ? 0 : 1,
    key.length,
    key,
  ];
  const before = (a: Array<number | string>, b: Array<number | string>): boolean => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  };

  let best = keys[0];
  for (const key of keys.slice(1)) {
    if (before(rank(key), rank(best))) best = key;
  }
  if (!own(best) && STRICT_VENDORS.has(String(vendor || '').trim().toLowerCase())) {
    return undefined;
  }
  const provider = providerOf(best, table[best]);
  if (best === name) {
    return { key: best, kind: 'exact', provider, ambiguous: false };
  }
  const providerCount = new Set(keys.map((k) => providerOf(k, table[k]))).size;
  return { key: best, kind: 'base', provider, ambiguous: !own(best) && providerCount > 1 };
}
