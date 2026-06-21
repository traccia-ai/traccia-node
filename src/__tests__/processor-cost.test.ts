/**
 * Cost processor alignment tests (mirrors traccia-py tests/test_pricing.py).
 */

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
