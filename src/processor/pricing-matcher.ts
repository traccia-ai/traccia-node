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
const STRICT_VENDORS: ReadonlySet<string> = new Set(['groq']);

export interface PriceMatch {
  key: string;
  kind: 'exact' | 'base';
  /** Pricing provider of the key ("" when unknown). */
  provider: string;
  /** A base match the vendor did not settle, among keys of several providers. */
  ambiguous: boolean;
}

type Table = Record<string, unknown>;

/** Lower-cased, without the provider path or region; the date is kept. */
function nameOf(name: string): string {
  const tail = name.trim().toLowerCase().split('/').pop() ?? '';
  return tail.replace(REGION, '');
}

export function baseName(name: string): string {
  return nameOf(name).replace(SUFFIX, '');
}

function providerOf(key: string, entry: unknown): string {
  let provider =
    entry && typeof entry === 'object' ? (entry as { _provider?: unknown })._provider : undefined;
  if (!provider && key.includes('/')) {
    provider = key.split('/', 1)[0];
  }
  return String(provider || '').toLowerCase();
}

function vendorProviders(vendor: string | null | undefined): string[] {
  const v = String(vendor || '').trim().toLowerCase();
  if (!v) return [];
  return Object.prototype.hasOwnProperty.call(VENDOR_PROVIDERS, v) ? VENDOR_PROVIDERS[v] : [v];
}

function inFamily(provider: string, families: string[]): boolean {
  return families.some(
    (f) => provider === f || provider.startsWith(`${f}_`) || provider.startsWith(`${f}-`),
  );
}

// Base name -> keys, per table. Rebuilt when the table's size changes.
const indexes = new WeakMap<Table, { size: number; index: Map<string, string[]> }>();

function indexFor(table: Table): Map<string, string[]> {
  const keys = Object.keys(table);
  const cached = indexes.get(table);
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
  return base ? [...(indexFor(table).get(base) ?? [])] : [];
}

/** Return the pricing key for `model`, or undefined. `vendor` is the span's llm.vendor. */
export function matchModel(
  model: string | null | undefined,
  table: Table | null | undefined,
  vendor?: string | null,
): PriceMatch | undefined {
  const keys = candidateKeys(model, table);
  if (!keys.length || !table) {
    return undefined;
  }
  const name = String(model);
  const wanted = nameOf(name);
  const providers = vendorProviders(vendor);
  const own = (key: string): boolean => inFamily(providerOf(key, table[key]), providers);
  // Same order as the Python sort key: (not own, not exact, not own same version, length, key).
  // A dated version only beats the generic key among the vendor's own keys.
  const rank = (key: string): Array<number | string> => [
    own(key) ? 0 : 1,
    key === name ? 0 : 1,
    own(key) && nameOf(key) === wanted ? 0 : 1,
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
