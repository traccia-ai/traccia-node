/**
 * Process-level singleton that holds the active pricing table.
 */

import { PricingTable, DEFAULT_PRICING } from '../config/pricing-config';

export class CostResolver {
  private table: PricingTable;
  private source: string;
  private generatedAt: string;

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
   */
  public compute(
    model: string,
    promptTokens: number,
    completionTokens: number
  ): number | undefined {
    const matched = this.lookupPrice(model);
    if (!matched) {
      return undefined;
    }

    const [, pricing] = matched;
    let cost = 0;
    if (promptTokens) {
      cost += (promptTokens / 1000) * pricing.inputCost;
    }
    if (completionTokens) {
      cost += (completionTokens / 1000) * pricing.outputCost;
    }

    return cost > 0 ? cost : undefined;
  }

  public matchPricingModelKey(model: string): string | undefined {
    return this.lookupPrice(model)?.[0];
  }

  private lookupPrice(model: string): [string, { inputCost: number; outputCost: number }] | undefined {
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
