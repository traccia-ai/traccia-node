/**
 * Cost annotation processor (aligned with traccia-py).
 */

import { ISpan, ISpanProcessor } from '../types';
import { PricingTable, snapshotAgeDays } from '../config/pricing-config';
import { CostResolver, getResolver, setResolver } from './cost-resolver';

const WARN_AFTER_DAYS = 30;
const INFO_AFTER_DAYS = 7;

let stalenessWarned = false;

export interface CostAnnotatingProcessorOptions {
  pricingTable?: PricingTable;
  pricingSource?: string;
  pricingGeneratedAt?: string;
}

/**
 * Set the cached pricing table (used during initialization).
 * @deprecated Use getResolver().update(pricing) instead.
 */
export function setCachedPricing(pricing: PricingTable): void {
  getResolver().update(pricing);
}

/**
 * Compute cost for a given model and token counts.
 */
export function computeCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number | undefined {
  return getResolver().compute(model, promptTokens, completionTokens);
}

function checkAndLogStaleness(generatedAt: string, ageDays: number | undefined): void {
  if (stalenessWarned || ageDays == null) {
    return;
  }

  if (ageDays > WARN_AFTER_DAYS) {
    stalenessWarned = true;
    console.warn(
      `Traccia SDK pricing snapshot is ${Math.floor(ageDays)} days old (from ${generatedAt}). ` +
        'Run pricing refresh for the latest rates, or view costs on the Traccia platform.',
    );
  } else if (ageDays > INFO_AFTER_DAYS) {
    stalenessWarned = true;
    console.info(
      `Traccia SDK pricing snapshot is ${Math.floor(ageDays)} days old (from ${generatedAt}).`,
    );
  }
}

function readTokenCount(
  attrs: Record<string, unknown>,
  primary: string,
  alias: string,
  legacy?: string,
): number | undefined {
  const value = attrs[primary] ?? attrs[alias] ?? (legacy ? attrs[legacy] : undefined);
  return typeof value === 'number' ? value : undefined;
}

/**
 * Cost annotation processor.
 */
export class CostAnnotatingProcessor implements ISpanProcessor {
  private pricingSource: string;
  private pricingGeneratedAt: string;

  constructor(options: CostAnnotatingProcessorOptions = {}) {
    if (options.pricingTable) {
      getResolver().update(
        options.pricingTable,
        options.pricingSource,
        options.pricingGeneratedAt,
      );
    }
    const resolver = getResolver();
    this.pricingSource = options.pricingSource ?? resolver.getSource;
    this.pricingGeneratedAt = options.pricingGeneratedAt ?? resolver.getGeneratedAt;
  }

  updatePricingTable(
    pricingTable: PricingTable,
    pricingSource?: string,
    pricingGeneratedAt?: string,
  ): void {
    getResolver().update(pricingTable, pricingSource, pricingGeneratedAt);
    if (pricingSource) {
      this.pricingSource = pricingSource;
    }
    if (pricingGeneratedAt) {
      this.pricingGeneratedAt = pricingGeneratedAt;
    }
  }

  onEnd(span: ISpan): void {
    try {
      const attrs = span.attributes || {};
      if (attrs['llm.cost.usd'] != null) {
        return;
      }

      const spanType = String(attrs['span.type'] ?? '').toLowerCase();
      if (spanType && spanType !== 'llm') {
        return;
      }

      const model = (attrs['llm.model'] ?? attrs['model']) as string | undefined;
      const promptTokens = readTokenCount(
        attrs,
        'llm.usage.prompt_tokens',
        'llm.usage.input_tokens',
        'input_tokens',
      );
      const completionTokens = readTokenCount(
        attrs,
        'llm.usage.completion_tokens',
        'llm.usage.output_tokens',
        'output_tokens',
      );

      if (!model || promptTokens == null || completionTokens == null) {
        return;
      }

      const resolver = getResolver();
      const cost = resolver.compute(model, promptTokens, completionTokens);
      if (cost == null) {
        return;
      }

      checkAndLogStaleness(this.pricingGeneratedAt, snapshotAgeDays(this.pricingGeneratedAt));

      span.setAttribute('llm.cost.usd', cost);
      span.setAttribute('cost_usd', cost);

      const usageSource =
        (attrs['llm.usage.source'] as string | undefined) ||
        (attrs['llm.cost.source'] as string | undefined) ||
        'unknown';
      span.setAttribute('llm.usage.source', usageSource);
      span.setAttribute('llm.cost.source', usageSource);
      span.setAttribute('llm.pricing.source', this.pricingSource);

      const modelKey = resolver.matchPricingModelKey(model);
      if (modelKey) {
        span.setAttribute('llm.pricing.model_key', modelKey);
      }

      span.setAttribute('llm.pricing.generated_at', this.pricingGeneratedAt);
      const ageDays = snapshotAgeDays(this.pricingGeneratedAt);
      if (ageDays != null) {
        span.setAttribute('llm.pricing.age_days', Math.floor(ageDays));
      }
      span.setAttribute('llm.pricing.snapshot_version', this.pricingGeneratedAt);
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

export { CostResolver, getResolver, setResolver };
