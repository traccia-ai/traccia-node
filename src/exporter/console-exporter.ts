/**
 * Console Exporter for debugging purposes.
 */

import { ISpan, ISpanExporter } from '../types';

/**
 * Console Exporter for printing spans to console.
 */
export class ConsoleExporter implements ISpanExporter {
  /**
   * Export spans to console.
   */
  public export(spans: ISpan[]): Promise<boolean> {
    for (const span of spans) {
      console.log('=== Span ===');
      console.log(`Name: ${span.name}`);
      console.log(`TraceId: ${span.context.traceId}`);
      console.log(`SpanId: ${span.context.spanId}`);
      console.log(`ParentSpanId: ${span.parentSpanId || 'none'}`);
      console.log(`Duration: ${span.durationNs}ns`);
      console.log(`Status: ${span.status}`);
      if (span.statusDescription) {
        console.log(`Status Description: ${span.statusDescription}`);
      }
      console.log('Attributes:', span.attributes);
      console.log('Events:', span.events);
    }
    return Promise.resolve(true);
  }

  /**
   * Shutdown the exporter.
   */
  public async shutdown(): Promise<void> {
    // No-op
  }
}
