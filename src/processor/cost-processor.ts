/**
 * Cost annotation processor.
 */

import { ISpan, ISpanProcessor } from '../types';
import { PricingTable, DEFAULT_PRICING } from '../config/pricing-config';

// Cached pricing table for computeCost
let cachedPricing: PricingTable | null = null;

/**
 * Set the cached pricing table (used during initialization).
 */
export function setCachedPricing(pricing: PricingTable): void {
  cachedPricing = pricing;
}

/**
 * Compute cost for a given model and token counts.
 *
 * @param model Model name
 * @param promptTokens Number of input/prompt tokens
 * @param completionTokens Number of output/completion tokens
 * @returns Cost in USD, or undefined if pricing not found
 */
export function computeCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number | undefined {
  // Use cached pricing or fall back to default
  const pricingTable = cachedPricing || DEFAULT_PRICING;

  const pricing = pricingTable[model];
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

/**
 * Cost annotation processor.
 */
export class CostAnnotatingProcessor implements ISpanProcessor {
  private pricingTable: PricingTable;

  constructor(pricingTable: PricingTable) {
    this.pricingTable = pricingTable;
  }

  onEnd(span: ISpan): void {
    try {
      const model = span.attributes['model'] as string | undefined;
      if (!model) {
        return;
      }

      const pricing = this.pricingTable[model];
      if (!pricing) {
        return;
      }

      const inputTokens = span.attributes['input_tokens'] as number | undefined;
      const outputTokens = span.attributes['output_tokens'] as number | undefined;

      let cost = 0;
      if (inputTokens) {
        cost += (inputTokens / 1000) * pricing.inputCost;
      }
      if (outputTokens) {
        cost += (outputTokens / 1000) * pricing.outputCost;
      }

      if (cost > 0) {
        // Direct attribute modification for processors (after span ends)
        span.attributes['cost_usd'] = cost;
      }
    } catch {
      // Silently fail
    }
  }

  async shutdown(): Promise<void> {
    // No-op
  }

  async forceFlush(): Promise<void> {
    // No-op
  }
}
