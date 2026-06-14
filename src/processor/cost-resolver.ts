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
    const pricing = this.table[model];
    if (!pricing) {
      return undefined;
    }

    let cost = 0;
    if (promptTokens) {
      cost += (promptTokens / 1000) * pricing.inputCost;
    }
    if (completionTokens) {
      cost += (completionTokens / 1000) * pricing.outputCost;
    }

    return cost > 0 ? cost : undefined;
  }

  public snapshot(): { table: PricingTable; source: string; generatedAt: string } {
    return {
      table: this.table,
      source: this.source,
      generatedAt: this.generatedAt
    };
  }
}

// Module-level singleton
let _resolver: CostResolver | null = null;

export function getResolver(): CostResolver {
  if (!_resolver) {
    _resolver = new CostResolver(DEFAULT_PRICING);
  }
  return _resolver;
}

export function setResolver(resolver: CostResolver): void {
  _resolver = resolver;
}
