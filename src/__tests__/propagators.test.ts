import { W3CTraceContextPropagator } from '../context/propagators';

describe('W3CTraceContextPropagator', () => {
  let propagator: W3CTraceContextPropagator;

  beforeEach(() => {
    propagator = new W3CTraceContextPropagator();
  });

  it('should inject trace context into carrier', () => {
    const carrier: Record<string, string> = {};
    const context = {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
      traceState: 'congo=t61rcWkgMzE'
    };

    propagator.inject(context, carrier);

    expect(carrier['traceparent']).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(carrier['tracestate']).toBe('congo=t61rcWkgMzE');
  });

  it('should extract trace context from carrier', () => {
    const carrier = {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'congo=t61rcWkgMzE'
    };

    const context = propagator.extract(carrier);

    expect(context).not.toBeNull();
    expect(context?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(context?.spanId).toBe('00f067aa0ba902b7');
    expect(context?.traceFlags).toBe(1);
    expect(context?.traceState).toBe('congo=t61rcWkgMzE');
  });

  it('should return null for invalid traceparent', () => {
    const carrier = {
      traceparent: 'invalid-header'
    };

    const context = propagator.extract(carrier);
    expect(context).toBeNull();
  });

  it('should handle missing tracestate', () => {
    const carrier = {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    };

    const context = propagator.extract(carrier);

    expect(context).not.toBeNull();
    expect(context?.traceState).toBeUndefined();
  });
});
