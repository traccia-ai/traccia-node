/**
 * Logging span processor for debugging.
 */

import { ISpan, ISpanProcessor } from '../types';

/**
 * Logging span processor.
 */
export class LoggingSpanProcessor implements ISpanProcessor {
  onEnd(span: ISpan): void {
    console.log(`[Span] ${span.name} (${span.context.traceId})`, {
      spanId: span.context.spanId,
      duration: span.durationNs,
      attributes: span.attributes,
    });
  }

  async shutdown(): Promise<void> {
    // No-op
  }

  async forceFlush(): Promise<void> {
    // No-op
  }
}
