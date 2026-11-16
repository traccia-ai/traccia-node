import { TracerProvider } from '../tracer/provider';
import {
  getContext,
  getCurrentSpan,
  runWithSpan,
  setCurrentSpan,
} from '../context/context';

describe('context helpers', () => {
  it('returns empty context when no span is active', () => {
    expect(getContext()).toEqual({});
    expect(getCurrentSpan()).toBeUndefined();
  });

  it('setCurrentSpan updates the active span within a run context', () => {
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('active-span');

    runWithSpan(span, () => {
      expect(getCurrentSpan()?.context.spanId).toBe(span.context.spanId);

      const replacement = tracer.startSpan('replacement');
      setCurrentSpan(replacement);
      expect(getCurrentSpan()?.context.spanId).toBe(replacement.context.spanId);

      replacement.end();
    });

    span.end();
  });

  it('child spans adopt setCurrentSpan replacements within run context', () => {
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const parent = tracer.startSpan('parent');

    runWithSpan(parent, () => {
      const replacement = tracer.startSpan('replacement');
      setCurrentSpan(replacement);

      const child = tracer.startSpan('child');
      expect(child.parentSpanId).toBe(replacement.context.spanId);
      expect(child.context.traceId).toBe(replacement.context.traceId);

      child.end();
      replacement.end();
    });

    parent.end();
  });

  it('child spans detach when setCurrentSpan is called with undefined', () => {
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const parent = tracer.startSpan('parent');

    runWithSpan(parent, () => {
      setCurrentSpan(undefined);

      const child = tracer.startSpan('child');
      expect(child.parentSpanId).toBeUndefined();
      expect(child.isLocalRoot).toBe(true);

      child.end();
    });

    parent.end();
  });

  it('child spans adopt setCurrentSpan outside of run context', () => {
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const manual = tracer.startSpan('manual');

    try {
      setCurrentSpan(manual);
      const child = tracer.startSpan('child');
      expect(child.parentSpanId).toBe(manual.context.spanId);
      expect(child.context.traceId).toBe(manual.context.traceId);
      child.end();
    } finally {
      setCurrentSpan(undefined);
      manual.end();
    }
  });
});
