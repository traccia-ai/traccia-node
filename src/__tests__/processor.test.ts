/**
 * Tests for processors.
 */

import { Sampler } from '../processor/sampler';
import { TokenCountingProcessor } from '../processor/token-counter';
import { CostAnnotatingProcessor } from '../processor/cost-processor';
import { LoggingSpanProcessor } from '../processor/logging-processor';
import { TracerProvider } from '../tracer/provider';
import { AgentEnrichmentProcessor } from '../processor/agent-enricher';
import { ISpan } from '../types';

describe('Sampler', () => {
  it('should reject invalid sample rates', () => {
    expect(() => new Sampler(-0.1)).toThrow();
    expect(() => new Sampler(1.1)).toThrow();
  });

  it('should always sample at rate 1.0', () => {
    const sampler = new Sampler(1.0);
    for (let i = 0; i < 10; i++) {
      expect(sampler.shouldSample().sampled).toBe(true);
    }
  });

  it('should never sample at rate 0.0', () => {
    const sampler = new Sampler(0.0);
    for (let i = 0; i < 10; i++) {
      expect(sampler.shouldSample().sampled).toBe(false);
    }
  });
});

describe('TokenCountingProcessor', () => {
  it('estimates llm.usage.* from llm.prompt and llm.completion', () => {
    const processor = new TokenCountingProcessor();
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test', {
      attributes: {
        'llm.prompt': 'hello world test',
        'llm.completion': 'response text here',
        'llm.model': 'gpt-4',
      },
    });

    processor.onEnd(span);

    expect(span.attributes['llm.usage.prompt_tokens']).toBeDefined();
    expect(span.attributes['llm.usage.completion_tokens']).toBeDefined();
    expect(span.attributes['llm.usage.total_tokens']).toBe(
      (span.attributes['llm.usage.prompt_tokens'] as number) +
        (span.attributes['llm.usage.completion_tokens'] as number),
    );
    expect(span.attributes['gen_ai.usage.input_tokens']).toBeDefined();
  });

  it('does not overwrite provider-reported token counts', () => {
    const processor = new TokenCountingProcessor();
    const span = {
      attributes: {
        'llm.prompt': 'ignored prompt text',
        'llm.usage.prompt_tokens': 42,
        'llm.usage.completion_tokens': 8,
        'llm.usage.source': 'provider_usage',
      },
    } as unknown as ISpan;

    processor.onEnd(span);

    expect(span.attributes['llm.usage.prompt_tokens']).toBe(42);
    expect(span.attributes['llm.usage.completion_tokens']).toBe(8);
    expect(span.attributes['llm.usage.source']).toBe('provider_usage');
  });

  it('estimates prompt tokens from llm.openai.messages', () => {
    const processor = new TokenCountingProcessor();
    const span = {
      attributes: {
        'llm.openai.messages': JSON.stringify([
          { role: 'user', content: 'hello there' },
        ]),
      },
    } as unknown as ISpan;

    processor.onEnd(span);

    expect(span.attributes['llm.usage.prompt_tokens']).toBeGreaterThan(0);
    expect(span.attributes['llm.usage.prompt_source']).toBe('estimated.chat_heuristic');
  });
});

describe('CostAnnotatingProcessor', () => {
  it('calculates llm.cost.usd from llm.usage.* attrs', () => {
    const processor = new CostAnnotatingProcessor({
      pricingTable: {
        'gpt-3.5-turbo': {
          inputCost: 0.0005,
          outputCost: 0.0015,
        },
      },
      pricingSource: 'bundled',
      pricingGeneratedAt: '2026-01-01T00:00:00Z',
    });

    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test', {
      attributes: {
        'llm.model': 'gpt-3.5-turbo',
        'llm.usage.prompt_tokens': 100,
        'llm.usage.completion_tokens': 50,
      },
    });

    processor.onEnd(span);

    expect(span.attributes['llm.cost.usd']).toBeDefined();
    expect((span.attributes['llm.cost.usd'] as number) > 0).toBe(true);
    expect(span.attributes['llm.pricing.source']).toBe('bundled');
    expect(span.attributes['llm.pricing.generated_at']).toBe('2026-01-01T00:00:00Z');
  });
});

describe('LoggingSpanProcessor', () => {
  it('should not throw on span end', () => {
    const processor = new LoggingSpanProcessor();
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test');

    span.end();
    expect(() => processor.onEnd(span)).not.toThrow();
  });
});

describe('AgentEnrichmentProcessor', () => {
  it('should skip agent enrichment when serviceRole is orchestrator', () => {
    const processor = new AgentEnrichmentProcessor({ serviceRole: 'orchestrator' });
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');

    const rootSpan = tracer.startSpan('workflow_start');
    processor.onStart(rootSpan);

    const childSpan = tracer.startSpan('agent_task');
    processor.onStart(childSpan);

    expect(childSpan.attributes['agent.id']).toBeUndefined();
  });
});
