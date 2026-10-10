/**
 * Match the model name a provider SDK reports to a key in the pricing table.
 *
 * Names are compared by their base name: lower-cased, without the provider path
 * (groq/openai/gpt-oss-120b -> gpt-oss-120b), a Bedrock region (us.), or a date or
 * -latest suffix. Among keys with the same base name, the span's vendor's own key wins,
 * then the shortest key. A name with no matching base name gets no price.
 *
 * Port of traccia-py pricing_matcher.py (also copied in traccia-dashboard-service as
 * app/services/pricing/matcher.py). All three run the shared cases in
 * src/__tests__/fixtures/pricing_match_cases.json, so keep them in step.
 */

const REGION = /^(?:us|eu|apac|au|ca|jp|global|us-gov)\./;
const SUFFIX = /(?:-\d{4}-\d{2}-\d{2}|-\d{8}|-latest)$/;

export interface PriceMatch {
  key: string;
  kind: 'exact' | 'base';
  /** Pricing provider of the key ("" when unknown). */
  provider: string;
}

type Table = Record<string, unknown>;

export function baseName(name: string): string {
  const tail = name.trim().toLowerCase().split('/').pop() ?? '';
  return tail.replace(REGION, '').replace(SUFFIX, '');
}

function providerOf(key: string, entry: unknown): string {
  let provider =
    entry && typeof entry === 'object' ? (entry as { _provider?: unknown })._provider : undefined;
  if (!provider && key.includes('/')) {
    provider = key.split('/', 1)[0];
  }
  return String(provider || '').toLowerCase();
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

const alnum = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Return the pricing key for `model`, or undefined. `vendor` is the span's llm.vendor. */
export function matchModel(
  model: string | null | undefined,
  table: Table | null | undefined,
  vendor?: string | null,
): PriceMatch | undefined {
  if (!model || !table || !String(model).trim() || Object.keys(table).length === 0) {
    return undefined;
  }
  const name = String(model);
  if (Object.prototype.hasOwnProperty.call(table, name)) {
    return { key: name, kind: 'exact', provider: providerOf(name, table[name]) };
  }
  const keys = indexFor(table).get(baseName(name));
  if (!keys) {
    return undefined;
  }
  const v = alnum(vendor || '');
  const own = (key: string): boolean => {
    const p = alnum(providerOf(key, table[key]));
    return Boolean(v && p) && (p.startsWith(v) || v.startsWith(p));
  };

  let best = keys[0];
  for (const key of keys.slice(1)) {
    const a = [own(key) ? 0 : 1, key.length];
    const b = [own(best) ? 0 : 1, best.length];
    if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && key < best)))) {
      best = key;
    }
  }
  return { key: best, kind: 'base', provider: providerOf(best, table[best]) };
}
