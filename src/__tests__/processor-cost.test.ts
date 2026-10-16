/**
 * Cost processor alignment tests (mirrors traccia-py tests/test_pricing.py).
 */

import { PricingTable } from '../config/pricing-config';
import { CostAnnotatingProcessor } from '../processor/cost-processor';
import { ISpan } from '../types';

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

describe('CostAnnotatingProcessor alignment', () => {
  const makeProcessor = (generatedAt = '2026-01-01T00:00:00Z') =>
    new CostAnnotatingProcessor({
      pricingTable: {
        'gpt-4o': { inputCost: 0.005, outputCost: 0.015 },
      },
      pricingSource: 'local_cache',
      pricingGeneratedAt: generatedAt,
    });

  it('sets llm.cost.usd', () => {
    const proc = makeProcessor();
    const span = new FakeSpan({
      'llm.model': 'gpt-4o',
      'llm.usage.prompt_tokens': 1000,
      'llm.usage.completion_tokens': 500,
    });
    proc.onEnd(span);
    expect(span.attributes['llm.cost.usd']).toBeDefined();
  });

  it('sets pricing metadata attrs', () => {
    const proc = makeProcessor();
    const span = new FakeSpan({
      'llm.model': 'gpt-4o',
      'llm.usage.prompt_tokens': 1000,
      'llm.usage.completion_tokens': 500,
    });
    proc.onEnd(span);
    expect(span.attributes['llm.pricing.generated_at']).toBe('2026-01-01T00:00:00Z');
    expect(span.attributes['llm.pricing.source']).toBe('local_cache');
    expect(span.attributes['llm.pricing.snapshot_version']).toBe('2026-01-01T00:00:00Z');
    expect(span.attributes['llm.pricing.model_key']).toBe('gpt-4o');
  });

  it('preserves llm.usage.source and sets llm.cost.source alias', () => {
    const proc = makeProcessor();
    const span = new FakeSpan({
      'llm.model': 'gpt-4o',
      'llm.usage.prompt_tokens': 100,
      'llm.usage.completion_tokens': 50,
      'llm.usage.source': 'openai',
    });
    proc.onEnd(span);
    expect(span.attributes['llm.usage.source']).toBe('openai');
    expect(span.attributes['llm.cost.source']).toBe('openai');
  });

  it('does not overwrite existing llm.cost.usd', () => {
    const proc = makeProcessor();
    const span = new FakeSpan({
      'llm.model': 'gpt-4o',
      'llm.usage.prompt_tokens': 1000,
      'llm.usage.completion_tokens': 500,
      'llm.cost.usd': 0.99,
    });
    proc.onEnd(span);
    expect(span.attributes['llm.cost.usd']).toBe(0.99);
  });

  it('matches version-suffixed model names via prefix lookup', () => {
    const proc = makeProcessor();
    const span = new FakeSpan({
      'llm.model': 'gpt-4o-2024-08-06',
      'llm.usage.prompt_tokens': 100,
      'llm.usage.completion_tokens': 50,
    });
    proc.onEnd(span);
    expect(span.attributes['llm.cost.usd']).toBeDefined();
    expect(span.attributes['llm.pricing.model_key']).toBe('gpt-4o');
  });

  it('skips non-LLM span.type (orchestration spans)', () => {
    const proc = makeProcessor();
    const span = new FakeSpan({
      'span.type': 'span',
      'llm.model': 'gpt-4o',
      'llm.usage.prompt_tokens': 1000,
      'llm.usage.completion_tokens': 500,
    });
    proc.onEnd(span);
    expect(span.attributes['llm.cost.usd']).toBeUndefined();
  });

  it('reads legacy input_tokens and output_tokens', () => {
    const proc = makeProcessor();
    const span = new FakeSpan({
      model: 'gpt-4o',
      input_tokens: 100,
      output_tokens: 50,
    });
    proc.onEnd(span);
    expect(span.attributes['llm.cost.usd']).toBeDefined();
  });

  it('skips spans with unknown models', () => {
    const proc = makeProcessor();
    const span = new FakeSpan({
      'llm.model': 'unknown-model-xyz',
      'llm.usage.prompt_tokens': 100,
      'llm.usage.completion_tokens': 50,
    });
    proc.onEnd(span);
    expect(span.attributes['llm.cost.usd']).toBeUndefined();
  });
});

describe('CostAnnotatingProcessor vendor pricing', () => {
  const makeProcessor = () =>
    new CostAnnotatingProcessor({
      pricingTable: {
        'ovhcloud/Qwen3-32B': { prompt: 0.00008, completion: 0.00023, _provider: 'ovhcloud' },
        'groq/qwen/qwen3-32b': { prompt: 0.00029, completion: 0.00059, _provider: 'groq' },
        'groq/openai/gpt-oss-120b': { prompt: 0.00015, completion: 0.0006, cached_prompt: 0.000075, _provider: 'groq' },
        'fireworks_ai/accounts/fireworks/models/gemma2-9b-it': { prompt: 0.0002, completion: 0.0002, _provider: 'fireworks_ai' },
        // Platform snapshot entries: per-1K prompt/completion rates and a provider.
      } as unknown as PricingTable,
      pricingSource: 'local_cache',
      pricingGeneratedAt: '2026-01-01T00:00:00Z',
    });

  it("prices a Groq span at Groq's price, as its settlement is", () => {
    const span = new FakeSpan({
      'llm.vendor': 'groq',
      'llm.model': 'qwen/qwen3-32b',
      'llm.usage.prompt_tokens': 1000,
      'llm.usage.completion_tokens': 1000,
    });
    makeProcessor().onEnd(span);
    expect(span.attributes['llm.cost.usd']).toBeCloseTo(0.00088);
    expect(span.attributes['llm.pricing.model_key']).toBe('groq/qwen/qwen3-32b');
  });

  it("prices a Groq span's cached tokens at the cached rate", () => {
    const span = new FakeSpan({
      'llm.vendor': 'groq',
      'llm.model': 'openai/gpt-oss-120b',
      'llm.usage.prompt_tokens': 200,
      'llm.usage.cache_read_tokens': 800,
      'llm.usage.completion_tokens': 0,
    });
    makeProcessor().onEnd(span);
    expect(span.attributes['llm.cost.usd']).toBeCloseTo(0.00003 + 0.00006);
  });

  it("leaves a Groq span unpriced rather than use another provider's price", () => {
    const span = new FakeSpan({
      'llm.vendor': 'groq',
      'llm.model': 'gemma2-9b-it',
      'llm.usage.prompt_tokens': 100,
      'llm.usage.completion_tokens': 50,
    });
    makeProcessor().onEnd(span);
    expect(span.attributes['llm.cost.usd']).toBeUndefined();
  });
});

describe('CostAnnotatingProcessor staleness logging', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs info when pricing snapshot is older than 7 days', () => {
    const oldTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const { CostAnnotatingProcessor } = require('../processor/cost-processor');

    const proc = new CostAnnotatingProcessor({
      pricingTable: { 'gpt-4o': { inputCost: 0.005, outputCost: 0.015 } },
      pricingGeneratedAt: oldTs,
    });
    const span = new FakeSpan({
      'llm.model': 'gpt-4o',
      'llm.usage.prompt_tokens': 100,
      'llm.usage.completion_tokens': 50,
    });

    proc.onEnd(span);

    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('pricing snapshot is'),
    );
  });

  it('logs warn when pricing snapshot is older than 30 days', () => {
    const oldTs = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const { CostAnnotatingProcessor } = require('../processor/cost-processor');

    const proc = new CostAnnotatingProcessor({
      pricingTable: { 'gpt-4o': { inputCost: 0.005, outputCost: 0.015 } },
      pricingGeneratedAt: oldTs,
    });
    const span = new FakeSpan({
      'llm.model': 'gpt-4o',
      'llm.usage.prompt_tokens': 100,
      'llm.usage.completion_tokens': 50,
    });

    proc.onEnd(span);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('pricing snapshot is'),
    );
  });
});
