/**
 * Process-level singleton that holds the active pricing table.
 */

import { PricingRates, PricingTable, readBundledSnapshot } from '../config/pricing-config';
import { baseName, inFamily, matchModel, nameOf, PriceMatch, providerOf, STRICT_VENDORS, vendorProviders } from './pricing-matcher';

export class CostResolver {
  private table: PricingTable;
  private source: string;
  private generatedAt: string;
  // Per-table indexes, built on first lookup and dropped by update(). Bounded by the
  // table size, unlike a per-model cache keyed by caller-supplied names.
  private lowerIndex?: Map<string, string>;
  private tailIndex?: Map<string, string>;
  /** The pricingOverride entries of the current table, built on first use and dropped by update(). */
  private overrideEntries?: Array<[string, PricingRates]>;

  constructor(
    pricingTable: PricingTable,
    source: string = 'bundled',
    generatedAt: string = 'unknown'
  ) {
    this.table = frozen(pricingTable);
    this.source = source;
    this.generatedAt = generatedAt;
  }

  public get pricingTable(): PricingTable {
    return this.table;
  }

  public get getSource(): string {
    return this.source;
  }

  public get getGeneratedAt(): string {
    return this.generatedAt;
  }

  /**
   * Replace the active pricing table (e.g. after a background refresh).
   */
  public update(
    pricingTable: PricingTable,
    source?: string,
    generatedAt?: string
  ): void {
    this.table = frozen(pricingTable);
    this.lowerIndex = undefined;
    this.tailIndex = undefined;
    this.overrideEntries = undefined;
    if (source) {
      this.source = source;
    }
    if (generatedAt) {
      this.generatedAt = generatedAt;
    }
  }

  /**
   * Return the estimated cost in USD, or undefined if the model has no pricing entry.
   * promptTokens is uncached input. Cache read and cache write use their own rates.
   */
  public compute(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    vendor?: string,
  ): number | undefined {
    return this.computeDetailed(model, promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens, vendor)?.cost;
  }

  public computeDetailed(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    vendor?: string,
  ): { cost: number; cacheFallback: boolean; match: PriceMatch } | undefined {
    const match = this.resolve(model, vendor);
    if (!match) {
      return undefined;
    }

    const pricing = this.table[match.key];
    const inputRate = rate(pricing, "inputCost", "prompt");
    const outputRate = rate(pricing, "outputCost", "completion");
    let cost = 0;
    let cacheFallback = false;
    if (promptTokens) cost += (promptTokens / 1000) * inputRate;
    if (completionTokens) cost += (completionTokens / 1000) * outputRate;
    if (cacheReadTokens) {
      const cached = optionalRate(pricing, "cacheReadCost", "cached_prompt");
      if (cached == null) cacheFallback = true;
      cost += (cacheReadTokens / 1000) * (cached ?? inputRate);
    }
    if (cacheWriteTokens) {
      const write = optionalRate(pricing, "cacheWriteCost", "cache_write");
      if (write == null) cacheFallback = true;
      cost += (cacheWriteTokens / 1000) * (write ?? inputRate);
    }

    if (cost <= 0) return undefined;
    return { cost, cacheFallback, match };
  }

  public matchPricingModelKey(model: string, vendor?: string): string | undefined {
    return this.resolve(model, vendor)?.key;
  }

  /**
   * The shared matcher (pricing-matcher.ts) decides whenever the table has a key with the
   * model's base name. Only when it has none, and the vendor is not strict, does the
   * lookup below try explicit aliases and @-dated keys (claude-sonnet-4-0,
   * claude-3-opus@20240229), which base names do not reach.
   */
  private resolve(model: string, vendor?: string): PriceMatch | undefined {
    return this.lookupOverride(model, vendor) ?? this.resolveBase(model, vendor);
  }

  private resolveBase(model: string, vendor?: string): PriceMatch | undefined {
    const match = matchModel(model, this.table, vendor);
    // For any other vendor the matcher answers whenever the table has the base name.
    if (match || STRICT_VENDORS.has(String(vendor || '').trim().toLowerCase())) {
      return match;
    }
    const found = this.lookupPrice(model);
    if (!found) {
      return undefined;
    }
    const [key, entry] = found;
    const provider = String((entry as { _provider?: unknown })._provider || (key.includes('/') ? key.split('/', 1)[0] : '')).toLowerCase();
    return { key, kind: key === model ? 'exact' : 'base', provider, ambiguous: false };
  }

  /**
   * For a call with a vendor, the user's pricingOverride entry for the model among those that
   * can be the vendor's price (see overrideFitsVendor): same base name, the key for the exact
   * name first, then the exact dated name, then the shortest. It wins over the bundled snapshot,
   * a local cache and the vendor's own keys. Without a vendor there is no pre-pass: the full
   * table is matched, where an override under the model's own key has replaced that entry.
   * Same as traccia-py's cost_engine._match.
   */
  private lookupOverride(model: string, vendor?: string): PriceMatch | undefined {
    if (!vendorProviders(vendor).length || !String(model || '').trim()) {
      return undefined;
    }
    if (this.overrideEntries === undefined) {
      this.overrideEntries = Object.entries(this.table).filter(([, rates]) => rates?._override);
    }
    const base = baseName(model);
    const keys = this.overrideEntries
      .filter(([key, rates]) => baseName(key) === base && overrideFitsVendor(key, rates, model, vendor!))
      .map(([key]) => key);
    if (!keys.length) {
      return undefined;
    }
    const wanted = nameOf(model);
    const rank = (key: string): Array<number | string> => [
      key === model ? 0 : 1,
      nameOf(key) === wanted ? 0 : 1,
      key.length,
      key,
    ];
    const key = keys.reduce((best, k) => (before(rank(k), rank(best)) ? k : best));
    return {
      key,
      kind: key === model ? 'exact' : 'base',
      provider: providerOf(key, this.table[key]),
      ambiguous: false,
    };
  }

  /**
   * Resolve a model name to a pricing key. Only exact IDs (case-insensitive),
   * provider-qualified IDs, explicit aliases and dated snapshot suffixes match.
   * There is no open prefix match: "gpt-4o-mini" must never price as "gpt-4".
   */
  private lookupPrice(model: string): [string, PricingRates] | undefined {
    const normalized = String(model || '').trim();
    if (!normalized) {
      return undefined;
    }
    // Every exact or alias candidate is tried before any provider-prefixed key, so
    // claude-3-opus prices as Anthropic's claude-3-opus-20240229, not vertex_ai/claude-3-opus.
    const candidates = modelCandidates(normalized);
    let key: string | undefined;
    for (const candidate of candidates) {
      key = this.matchExact(candidate);
      if (key !== undefined) break;
    }
    if (key === undefined) {
      for (const candidate of candidates) {
        key = this.matchProviderPrefixed(candidate);
        if (key !== undefined) break;
      }
    }
    return key === undefined ? undefined : [key, this.table[key]];
  }

  private matchExact(name: string): string | undefined {
    if (hasOwn(this.table, name)) {
      return name;
    }
    this.buildIndexes();
    return this.lowerIndex!.get(name.toLowerCase());
  }

  /** Provider-prefixed keys: grok-4.7 -> xai/grok-4.7. Shortest key wins. */
  private matchProviderPrefixed(name: string): string | undefined {
    this.buildIndexes();
    return this.tailIndex!.get(name.toLowerCase());
  }

  private buildIndexes(): void {
    if (this.lowerIndex && this.tailIndex) {
      return;
    }
    const lower = new Map<string, string>();
    const tail = new Map<string, string>();
    for (const key of Object.keys(this.table)) {
      const k = key.toLowerCase();
      if (!lower.has(k)) lower.set(k, key);
      const t = modelTail(key).toLowerCase();
      const prev = tail.get(t);
      if (prev === undefined || key.length < prev.length) tail.set(t, key);
    }
    this.lowerIndex = lower;
    this.tailIndex = tail;
  }

  public snapshot(): { table: PricingTable; source: string; generatedAt: string } {
    return {
      table: this.table,
      source: this.source,
      generatedAt: this.generatedAt
    };
  }
}

// Process-level singleton using globalThis
const GLOBAL_RESOLVER_KEY = Symbol.for('__TRACCIA_COST_RESOLVER__');

export function getResolver(): CostResolver {
  const globalAny = globalThis as any;
  if (!globalAny[GLOBAL_RESOLVER_KEY]) {
    // Before init() runs: the shipped snapshot, or an empty table (unpriced) if it is missing.
    const bundled = readBundledSnapshot();
    globalAny[GLOBAL_RESOLVER_KEY] = bundled
      ? new CostResolver(bundled.models, 'bundled', bundled.generatedAt ?? 'unknown')
      : new CostResolver({}, 'default', 'unknown');
  }
  return globalAny[GLOBAL_RESOLVER_KEY];
}

export function setResolver(resolver: CostResolver): void {
  const globalAny = globalThis as any;
  globalAny[GLOBAL_RESOLVER_KEY] = resolver;
}

/**
 * Whether an override can price a call to `model` made through `vendor`. An override that names a
 * provider (_provider/provider) must name the vendor's provider family (with the matcher's
 * aliases, so google_gemini covers gemini). Otherwise its key's path (every segment but the
 * last) must be empty, the model's path, or a vendor-family provider followed by the model's
 * path, so "together_ai/llama-3.3-70b-versatile" never prices Groq's "llama-3.3-70b-versatile"
 * while "openai/gpt-oss-120b", Groq's own model id, does. traccia-py applies the same rule.
 */
function overrideFitsVendor(key: string, pricing: PricingRates, model: string, vendor: string): boolean {
  const families = vendorProviders(vendor);
  const named = String(pricing?._provider ?? pricing?.provider ?? '').toLowerCase();
  if (named) {
    return inFamily(named, families);
  }
  const path = (name: string): string[] => name.trim().toLowerCase().split('/').slice(0, -1);
  let modelPath = path(model);
  if (modelPath.length && inFamily(modelPath[0], families)) {
    modelPath = modelPath.slice(1); // "groq/llama-3.3-70b-versatile": the vendor's own prefix
  }
  const keyPath = path(key);
  const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((s, i) => s === b[i]);
  if (keyPath.length === 0 || same(keyPath, modelPath)) {
    return true;
  }
  const [provider, ...rest] = keyPath;
  return same(rest, modelPath) && inFamily(provider, families);
}

/** Whether rank `a` sorts before rank `b`, element by element (a Python tuple comparison). */
function before(a: Array<number | string>, b: Array<number | string>): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** The table itself when already frozen, else a frozen shallow copy (the caller's object is left alone). */
function frozen(table: PricingTable): PricingTable {
  return Object.isFrozen(table) ? table : Object.freeze({ ...table });
}

function rate(pricing: PricingRates, primary: keyof PricingRates, alias: keyof PricingRates): number {
  const value = pricing[primary] ?? pricing[alias];
  return typeof value === "number" ? value : 0;
}

function optionalRate(pricing: PricingRates, primary: keyof PricingRates, alias: keyof PricingRates): number | undefined {
  const value = pricing[primary] ?? pricing[alias];
  return typeof value === "number" ? value : undefined;
}

/**
 * Explicit aliases for model names that providers accept but the pricing
 * snapshot only lists under a dated ID. A target missing from the active table
 * leaves the model unpriced.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
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

// Dated snapshot suffixes: gpt-4o-2024-08-06, claude-3-opus-20240229, claude-3-opus@20240229.
const DATED_SUFFIX = /^(.+?)[-@](?:\d{4}-\d{2}-\d{2}|\d{8})$/;

/**
 * Names to try, in order: the model itself, its alias, the name without a
 * provider prefix (openai/gpt-4o-mini), then the same without a dated suffix.
 */
export function modelCandidates(model: string): string[] {
  const out: string[] = [];
  const add = (name: string | undefined): void => {
    if (name && !out.includes(name)) out.push(name);
  };
  const withAlias = (name: string): void => {
    add(name);
    const lower = name.toLowerCase();
    if (hasOwn(MODEL_ALIASES, lower)) add(MODEL_ALIASES[lower]);
  };

  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : undefined;
  withAlias(model);
  if (bare) withAlias(bare);
  for (const name of [model, bare]) {
    const undated = name ? DATED_SUFFIX.exec(name)?.[1] : undefined;
    if (undated) withAlias(undated);
  }
  return out;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function modelTail(key: string): string {
  const tail = key.replace(/\\/g, "/").split("/").pop() ?? key;
  const dot = tail.indexOf(".");
  if (dot > 0) {
    const head = tail.slice(0, dot);
    const rest = tail.slice(dot + 1);
    // A dotted provider prefix (bedrock's "anthropic.claude-...") is letters and hyphens
    // only, as in traccia-py; in "llama-3.3-70b" the dot is part of the version.
    if (/^[a-z]+(-[a-z]+)*$/i.test(head) && rest.includes("-")) return rest;
  }
  return tail;
}
