/**
 * Shared pricing match cases (same fixture as traccia-py and traccia-dashboard-service),
 * so the Node SDK, the Python SDK and the platform pick the same pricing key for a span.
 */

import * as fs from 'fs';
import * as path from 'path';
import { matchModel } from '../processor/pricing-matcher';
import { CostAnnotatingProcessor } from '../processor/cost-processor';
import { CostResolver, setResolver } from '../processor/cost-resolver';
import { ISpan } from '../types';

interface Case {
  model: string;
  vendor: string | null;
  key: string | null;
  kind: 'exact' | 'base' | null;
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'pricing_match_cases.json'), 'utf8'),
) as { table: Record<string, unknown>; cases: Case[] };

describe('matchModel shared cases', () => {
  it.each(fixture.cases.map((c) => [`${c.model}|${c.vendor}`, c] as const))('%s', (_id, c) => {
    const result = matchModel(c.model, fixture.table, c.vendor);
    if (c.key === null) {
      expect(result).toBeUndefined();
    } else {
      expect(result).toBeDefined();
      expect([result!.key, result!.kind]).toEqual([c.key, c.kind]);
    }
  });
});

class FakeSpan implements ISpan {
  attributes: Record<string, unknown> = {};
  events = [];
  status = 0;
  startTimeNs = 0;
  endTimeNs = 0;
  durationNs = 0;
  name = 'fake';
  context = { traceId: 'trace', spanId: 'span', traceFlags: 1 };

  constructor(attrs: Record<string, unknown>) {
    this.attributes = { ...attrs };
  }

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }

  addEvent(): void {}
  recordException(): void {}
  end(): void {}
  isRecording(): boolean {
    return false;
  }
}

describe('CostAnnotatingProcessor pricing match', () => {
  afterEach(() => {
    setResolver(new CostResolver({}, 'bundled', 'unknown'));
  });

  it("prices a span at its vendor's rate and records how it matched", () => {
    const proc = new CostAnnotatingProcessor({
      pricingTable: {
        'together_ai/openai/gpt-oss-120b': { inputCost: 1, outputCost: 1, _provider: 'together_ai' } as any,
        'groq/openai/gpt-oss-120b': { inputCost: 0.1, outputCost: 0.1, _provider: 'groq' } as any,
      },
      pricingSource: 'local_cache',
      pricingGeneratedAt: '2026-01-01T00:00:00Z',
    });
    const span = new FakeSpan({
      'llm.vendor': 'groq',
      'llm.model': 'openai/gpt-oss-120b',
      'llm.usage.prompt_tokens': 1000,
      'llm.usage.completion_tokens': 1000,
    });
    proc.onEnd(span);
    expect(span.attributes['llm.cost.usd']).toBeCloseTo(0.2);
    expect(span.attributes['llm.pricing.model_key']).toBe('groq/openai/gpt-oss-120b');
    expect(span.attributes['llm.pricing.match_kind']).toBe('base');
    expect(span.attributes['llm.pricing.provider']).toBe('groq');
  });

  it('does not price a model by a key its name only starts with', () => {
    const resolver = new CostResolver({
      'gpt-4': { inputCost: 0.03, outputCost: 0.06 },
      'gpt-4o': { inputCost: 0.005, outputCost: 0.015 },
    });
    expect(resolver.matchPricingModelKey('gpt-4o-mini')).toBeUndefined();
  });
});
