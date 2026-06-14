/**
 * Context propagators for W3C trace context extraction and injection.
 */

import { ISpanContext } from '../types';

export interface TextMapPropagator {
  inject(context: ISpanContext, carrier: Record<string, string>): void;
  extract(carrier: Record<string, string>): ISpanContext | null;
}

export class W3CTraceContextPropagator implements TextMapPropagator {
  private static readonly TRACE_PARENT_HEADER = 'traceparent';
  private static readonly TRACE_STATE_HEADER = 'tracestate';

  /**
   * Inject trace context into carrier (e.g., HTTP headers)
   */
  public inject(context: ISpanContext, carrier: Record<string, string>): void {
    if (!context || !context.traceId || !context.spanId) {
      return;
    }

    const version = '00';
    const traceFlags = context.traceFlags?.toString(16).padStart(2, '0') || '00';
    const traceparent = `${version}-${context.traceId}-${context.spanId}-${traceFlags}`;
    carrier[W3CTraceContextPropagator.TRACE_PARENT_HEADER] = traceparent;

    if (context.traceState) {
      carrier[W3CTraceContextPropagator.TRACE_STATE_HEADER] = context.traceState;
    }
  }

  /**
   * Extract trace context from carrier
   */
  public extract(carrier: Record<string, string>): ISpanContext | null {
    const traceparent = this.getHeader(carrier, W3CTraceContextPropagator.TRACE_PARENT_HEADER);
    if (!traceparent) {
      return null;
    }

    // traceparent format: 00-traceId-spanId-traceFlags
    const parts = traceparent.split('-');
    if (parts.length !== 4) {
      return null;
    }

    const [, traceId, spanId, traceFlagsStr] = parts;
    const traceFlags = parseInt(traceFlagsStr, 16);
    const traceState = this.getHeader(carrier, W3CTraceContextPropagator.TRACE_STATE_HEADER);

    return { traceId, spanId, traceFlags, traceState: traceState || undefined };
  }

  private getHeader(carrier: Record<string, string>, name: string): string | null {
    const value = carrier[name] || carrier[name.toLowerCase()];
    return typeof value === 'string' ? value : null;
  }
}
