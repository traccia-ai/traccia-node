import { getTracerProvider } from './auto';
import { SpanStatus } from './types';

/**
 * Run a function within one root trace, so every span it creates joins that trace.
 *
 * init() never starts a root trace: each top-level call is its own trace. Use this to
 * group several calls, like the Python SDK's `with traccia.trace(name):`.
 */
export async function runWithAutoTrace<T>(
    name: string,
    fn: () => Promise<T> | T
): Promise<T> {
    const provider = getTracerProvider();
    const tracer = provider.getTracer('traccia.auto');

    return tracer.startActiveSpan(name, async (span) => {
        span.setAttribute('traccia.auto_started', true);
        try {
            return await fn();
        } catch (error) {
            if (error instanceof Error) {
                span.recordException(error);
                span.status = SpanStatus.ERROR;
                if (error.message) {
                    span.statusDescription = error.message;
                }
            }
            throw error;
        } finally {
            span.end();
        }
    });
}
