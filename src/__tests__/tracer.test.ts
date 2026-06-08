/**
 * Tests for tracer and provider.
 */

import { TracerProvider } from '../tracer/provider';
import { Sampler } from '../processor/sampler';

describe('TracerProvider', () => {
  it('should create and cache tracers', () => {
    const provider = new TracerProvider();
    const tracer1 = provider.getTracer('scope1');
    const tracer2 = provider.getTracer('scope1');

    expect(tracer1).toBe(tracer2);
  });

  it('should support multiple tracers', () => {
    const provider = new TracerProvider();
    const tracer1 = provider.getTracer('scope1');
    const tracer2 = provider.getTracer('scope2');

    expect(tracer1).not.toBe(tracer2);
  });

  it('should set and get sampler', () => {
    const provider = new TracerProvider();
    const sampler = new Sampler(0.5);

    provider.setSampler(sampler);
    expect(provider.getSampler()).toBe(sampler);
  });

  it('should generate unique IDs', () => {
    const provider = new TracerProvider();
    const traceId1 = provider.generateTraceId();
    const traceId2 = provider.generateTraceId();

    expect(traceId1).not.toBe(traceId2);
    expect(traceId1).toHaveLength(32);
    expect(traceId2).toHaveLength(32);
  });
});

describe('Tracer', () => {
  let provider: TracerProvider;

  beforeEach(() => {
    provider = new TracerProvider();
  });

  it('should create spans', () => {
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span');

    expect(span.name).toBe('test-span');
    expect(span.context.traceId).toBeTruthy();
    expect(span.context.spanId).toBeTruthy();
  });

  it('should create child spans', () => {
    const tracer = provider.getTracer('test');
    const parent = tracer.startSpan('parent');
    const child = tracer.startSpan('child', { parent });

    expect(child.context.traceId).toBe(parent.context.traceId);
    expect(child.parentSpanId).toBe(parent.context.spanId);
  });

  it('should respect sampling', () => {
    const provider2 = new TracerProvider();
    const sampler = new Sampler(0); // Never sample
    provider2.setSampler(sampler);

    const tracer = provider2.getTracer('test');
    const span = tracer.startSpan('test-span');

    expect(span.context.traceFlags).toBe(0);
  });

  it('should support active spans', async () => {
    const tracer = provider.getTracer('test');
    const result = await tracer.startActiveSpan('active-span', async (span) => {
      span.setAttribute('test', 'value');
      return 'result';
    });

    expect(result).toBe('result');
  });
});
