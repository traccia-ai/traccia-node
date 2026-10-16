/**
 * Process-level singleton that holds the active pricing table.
 */

import { PricingRates, PricingTable, DEFAULT_PRICING } from '../config/pricing-config';

/**
 * llm.vendor values set only by that provider's own SDK, which calls no other provider. Their
 * calls are priced only from that provider's entries, never from another provider's entry for
 * the same model name, which can be priced very differently. The platform's pricing matcher
 * applies the same rule (as does traccia-py's cost engine).
 */
export const STRICT_VENDORS: ReadonlySet<string> = new Set(['groq']);

const REGION = /^(?:us|eu|apac|au|ca|jp|global|us-gov)\./;
const SUFFIX = /(?:-\d{4}-\d{2}-\d{2}|-\d{8}|-latest)$/;

export class CostResolver {
  private table: PricingTable;
  private source: string;
  private generatedAt: string;
  /** The vendor keys of the current table by base name, built on first use per vendor. */
  private vendorIndex?: { table: PricingTable; vendor: string; keys: Map<string, string[]> };

  constructor(
    pricingTable: PricingTable,
    source: string = 'bundled',
    generatedAt: string = 'unknown'
  ) {
    this.table = pricingTable;
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
    this.table = pricingTable;
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
   * A vendor in STRICT_VENDORS is priced only from its own entries (see lookupVendorPrice);
   * any other vendor is not used.
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
  ): { cost: number; cacheFallback: boolean } | undefined {
    const matched = this.match(model, vendor);
    if (!matched) {
      return undefined;
    }

    const [, pricing] = matched;
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
    return { cost, cacheFallback };
  }

  public matchPricingModelKey(model: string, vendor?: string): string | undefined {
    return this.match(model, vendor)?.[0];
  }

  private match(model: string, vendor?: string): [string, PricingRates] | undefined {
    const strict = strictVendor(vendor);
    return strict ? this.lookupVendorPrice(model, strict) : this.lookupPrice(model);
  }

  /**
   * The vendor's own entry for a model: a vendor key with the same base name (lower-cased,
   * without the provider path, a region, or a date or -latest suffix), the key for the exact
   * dated name first, then the shortest. Undefined when the vendor has no such key.
   */
  private lookupVendorPrice(model: string, vendor: string): [string, PricingRates] | undefined {
    const wanted = modelName(String(model || ''));
    const keys = wanted ? this.vendorKeys(vendor).get(wanted.replace(SUFFIX, '')) : undefined;
    if (!keys || !keys.length) {
      return undefined;
    }
    const exact = (k: string): number => (modelName(k) === wanted ? 0 : 1);
    const [key] = [...keys].sort(
      (a, b) => exact(a) - exact(b) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
    );
    return [key, this.table[key]];
  }

  private vendorKeys(vendor: string): Map<string, string[]> {
    const cached = this.vendorIndex;
    if (cached && cached.table === this.table && cached.vendor === vendor) {
      return cached.keys;
    }
    const keys = new Map<string, string[]>();
    for (const [key, value] of Object.entries(this.table)) {
      if (inVendorFamily(key, value, vendor)) {
        const base = baseName(key);
        const bucket = keys.get(base);
        if (bucket) bucket.push(key);
        else keys.set(base, [key]);
      }
    }
    this.vendorIndex = { table: this.table, vendor, keys };
    return keys;
  }

  private lookupPrice(model: string): [string, PricingRates] | undefined {
    const normalized = String(model || '').trim();
    if (!normalized) {
      return undefined;
    }

    if (this.table[normalized]) {
      return [normalized, this.table[normalized]];
    }

    const lower = normalized.toLowerCase();
    for (const [key, value] of Object.entries(this.table)) {
      if (key.toLowerCase() === lower) {
        return [key, value];
      }
    }

    const keys = Object.keys(this.table).sort((a, b) => b.length - a.length);
    const suffixHits: Array<[string, PricingRates]> = [];
    for (const [key, value] of Object.entries(this.table)) {
      if (modelTail(key).toLowerCase() === lower) {
        suffixHits.push([key, value]);
      }
    }
    if (suffixHits.length) {
      suffixHits.sort((a, b) => a[0].length - b[0].length);
      return suffixHits[0];
    }
    for (const key of keys) {
      if (lower.startsWith(key.toLowerCase())) {
        return [key, this.table[key]];
      }
    }

    return undefined;
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
    globalAny[GLOBAL_RESOLVER_KEY] = new CostResolver(DEFAULT_PRICING);
  }
  return globalAny[GLOBAL_RESOLVER_KEY];
}

export function setResolver(resolver: CostResolver): void {
  const globalAny = globalThis as any;
  globalAny[GLOBAL_RESOLVER_KEY] = resolver;
}

function rate(pricing: PricingRates, primary: keyof PricingRates, alias: keyof PricingRates): number {
  const value = pricing[primary] ?? pricing[alias];
  return typeof value === "number" ? value : 0;
}

function optionalRate(pricing: PricingRates, primary: keyof PricingRates, alias: keyof PricingRates): number | undefined {
  const value = pricing[primary] ?? pricing[alias];
  return typeof value === "number" ? value : undefined;
}

function strictVendor(vendor: unknown): string | undefined {
  const v = typeof vendor === 'string' ? vendor.trim().toLowerCase() : '';
  return STRICT_VENDORS.has(v) ? v : undefined;
}

/** Lower-cased, without the provider path or region; the date is kept. */
function modelName(name: string): string {
  return (name.trim().toLowerCase().split('/').pop() ?? '').replace(REGION, '');
}

function baseName(name: string): string {
  return modelName(name).replace(SUFFIX, '');
}

/**
 * Whether the entry is the vendor's: its provider (the entry's, else the key's first path
 * segment) is the vendor, or a variant after "_" or "-", as the platform's matcher counts
 * provider families.
 */
function inVendorFamily(key: string, pricing: PricingRates, vendor: string): boolean {
  let provider = pricing?._provider ?? pricing?.provider;
  if (!provider && key.includes('/')) {
    provider = key.split('/', 1)[0];
  }
  const p = typeof provider === 'string' ? provider.toLowerCase() : '';
  return p === vendor || p.startsWith(vendor + '_') || p.startsWith(vendor + '-');
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
