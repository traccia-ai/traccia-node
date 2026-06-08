import { getTracerProvider } from './auto';
import { SpanStatus } from './types';

/**
 * Run a function within an auto-started root trace.
 *
 * This mimics the Python SDK's auto_start_trace behavior but adapted for
 * Node.js's callback-based context management.
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
