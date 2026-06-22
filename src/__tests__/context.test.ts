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
});
