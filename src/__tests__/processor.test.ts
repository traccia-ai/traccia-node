/**
 * Tests for processors.
 */

import { Sampler } from '../processor/sampler';
import { TokenCountingProcessor } from '../processor/token-counter';
import { CostAnnotatingProcessor } from '../processor/cost-processor';
import { LoggingSpanProcessor } from '../processor/logging-processor';
import { TracerProvider } from '../tracer/provider';

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
  it('should estimate tokens from text', () => {
    const processor = new TokenCountingProcessor();
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test', {
      attributes: {
        prompt: 'a'.repeat(1000),
        completion: 'b'.repeat(500),
      },
    });

    span.end();
    processor.onEnd(span);

    expect(span.attributes.input_tokens).toBeDefined();
    expect(span.attributes.output_tokens).toBeDefined();
  });
});

describe('CostAnnotatingProcessor', () => {
  it('should calculate costs', () => {
    const processor = new CostAnnotatingProcessor({
      'gpt-3.5-turbo': {
        inputCost: 0.0005,
        outputCost: 0.0015,
      },
    });

    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test', {
      attributes: {
        model: 'gpt-3.5-turbo',
        input_tokens: 100,
        output_tokens: 50,
      },
    });

    span.end();
    processor.onEnd(span);

    expect(span.attributes.cost_usd).toBeDefined();
    expect((span.attributes.cost_usd as number) > 0).toBe(true);
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
