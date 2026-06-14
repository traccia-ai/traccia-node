/**
 * Tests for span and span context.
 */

import { TracerProvider } from '../tracer/provider';
import { SpanStatus } from '../types';


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
