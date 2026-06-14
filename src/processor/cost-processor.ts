/**
 * Cost annotation processor.
 */

import { ISpan, ISpanProcessor } from '../types';
import { PricingTable } from '../config/pricing-config';
import { getResolver } from './cost-resolver';

/**
 * Set the cached pricing table (used during initialization).
 * @deprecated Use getResolver().update(pricing) instead.
 */
export function setCachedPricing(pricing: PricingTable): void {
  getResolver().update(pricing);
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
  return getResolver().compute(model, promptTokens, completionTokens);
}

/**
 * Cost annotation processor.
 */
export class CostAnnotatingProcessor implements ISpanProcessor {
  constructor(initialPricingTable?: PricingTable) {
    if (initialPricingTable) {
      getResolver().update(initialPricingTable);
    }
  }

  onEnd(span: ISpan): void {
    try {
      const model = span.attributes['model'] as string | undefined;
      if (!model) {
        return;
      }

      const inputTokens = span.attributes['input_tokens'] as number | undefined;
      const outputTokens = span.attributes['output_tokens'] as number | undefined;

      const cost = getResolver().compute(
        model,
        inputTokens || 0,
        outputTokens || 0
      );

      if (cost && cost > 0) {
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
