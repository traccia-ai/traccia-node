/**
 * Exceptions are exported as one `exception` event per occurrence, with the
 * attributes the platform reads (exception.type / message / stacktrace).
 *
 * Reads the underlying OpenTelemetry span after `end()`: its events are exactly what
 * the exporter sends.
 */
import { TracerProvider } from '../tracer/provider';
import { spanScope } from '../context/span-scope';

type OtelEvent = { name: string; attributes?: Record<string, unknown> };

function exportedExceptions(span: unknown): OtelEvent[] {
  const otel = (span as { otelSpan: { events: OtelEvent[] } }).otelSpan;
  return otel.events.filter((e) => e.name === 'exception');
}

class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

describe('exception recording', () => {
  const tracer = new TracerProvider().getTracer('exception-test');

  it('records one event when an Error is thrown inside startActiveSpan', async () => {
    let captured: unknown;
    await expect(
      tracer.startActiveSpan('active', async (span) => {
        captured = span;
        throw new TypeError('bad input');
      }),
    ).rejects.toThrow('bad input');
    const [event, ...rest] = exportedExceptions(captured);
    expect(rest).toHaveLength(0);
    expect(event.attributes?.['exception.type']).toBe('TypeError');
    expect(event.attributes?.['exception.message']).toBe('bad input');
    expect(String(event.attributes?.['exception.stacktrace'])).toContain('TypeError: bad input');
  });

  it('keeps a custom error class name as the type', async () => {
    let captured: unknown;
    await expect(
      tracer.startActiveSpan('custom', async (span) => {
        captured = span;
        throw new QuotaExceededError('over quota');
      }),
    ).rejects.toThrow('over quota');
    expect(exportedExceptions(captured)[0].attributes?.['exception.type']).toBe('QuotaExceededError');
  });

  it('records nothing in startActiveSpan for a thrown string (only Error instances are recorded)', async () => {
    let captured: unknown;
    await expect(
      tracer.startActiveSpan('string-throw', async (span) => {
        captured = span;
        throw 'plain string';
      }),
    ).rejects.toBe('plain string');
    expect(exportedExceptions(captured)).toHaveLength(0);
  });

  it('wraps a thrown string passed to spanScope.end as type Error', () => {
    const scope = spanScope('scoped');
    scope.end('plain string' as unknown);
    const [event] = exportedExceptions(scope.span);
    expect(event.attributes?.['exception.type']).toBe('Error');
    expect(event.attributes?.['exception.message']).toBe('plain string');
  });

  it('omits the stack trace attribute when the error has no stack', () => {
    const span = tracer.startSpan('no-stack');
    const err = new Error('no stack');
    err.stack = undefined;
    span.recordException(err);
    span.end();
    const [event] = exportedExceptions(span);
    expect(event.attributes).not.toHaveProperty('exception.stacktrace');
    expect(event.attributes?.['exception.message']).toBe('no stack');
  });

  it('records the same error twice when it is recorded in two attempts', () => {
    const span = tracer.startSpan('retries');
    const err = new Error('flaky');
    span.recordException(err);
    span.recordException(err);
    span.end();
    expect(exportedExceptions(span)).toHaveLength(2);
  });
});
