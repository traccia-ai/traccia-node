/**
 * Tests for span and span context.
 */

import { SpanContext } from '../tracer/span-context';
import { TracerProvider } from '../tracer/provider';
import { SpanStatus } from '../types';

describe('SpanContext', () => {
  it('should create a valid span context', () => {
    const ctx = new SpanContext('trace123', 'span456', 1, 'state=value');
    expect(ctx.traceId).toBe('trace123');
    expect(ctx.spanId).toBe('span456');
    expect(ctx.traceFlags).toBe(1);
    expect(ctx.traceState).toBe('state=value');
  });

  it('should validate context', () => {
    const valid = new SpanContext('a'.repeat(32), 'b'.repeat(16));
    expect(valid.isValid()).toBe(true);

    const invalid = new SpanContext('0'.repeat(32), 'b'.repeat(16));
    expect(invalid.isValid()).toBe(false);
  });

  it('should determine if sampled', () => {
    const sampled = new SpanContext('trace', 'span', 1);
    expect(sampled.isSampled()).toBe(true);

    const notSampled = new SpanContext('trace', 'span', 0);
    expect(notSampled.isSampled()).toBe(false);
  });
});

describe('Span', () => {
  let provider: TracerProvider;

  beforeEach(() => {
    provider = new TracerProvider();
  });

  it('should create a span with attributes', () => {
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span', {
      attributes: { key: 'value' },
    });

    expect(span.name).toBe('test-span');
    expect(span.attributes.key).toBe('value');
    expect(span.isRecording()).toBe(true);
  });

  it('should set attributes on span', () => {
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span');

    span.setAttribute('foo', 'bar');
    expect(span.attributes.foo).toBe('bar');
  });

  it('should add events to span', () => {
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span');

    span.addEvent('event1', { data: 'value' });
    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe('event1');
  });

  it('should record exceptions', () => {
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span');

    const error = new Error('Test error');
    span.recordException(error);

    expect(span.status).toBe(SpanStatus.ERROR);
    expect(span.statusDescription).toBe('Test error');
  });

  it('should end span and calculate duration', () => {
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span');

    expect(span.endTimeNs).toBeUndefined();
    span.end();
    expect(span.endTimeNs).toBeDefined();
    expect(span.durationNs).toBeGreaterThan(0);
    expect(span.isRecording()).toBe(false);
  });

  it('should not allow modifications after end', () => {
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span');

    span.end();
    span.setAttribute('foo', 'bar');
    span.addEvent('event');

    expect(span.attributes.foo).toBeUndefined();
    expect(span.events).toHaveLength(0);
  });
});
