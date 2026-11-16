/**
 * Context propagators for W3C trace context extraction and injection.
 */

import { parseTraceParent } from '@opentelemetry/core';
import { ISpanContext } from '../types';

export type HeaderCarrier = Record<string, string | string[] | undefined>;

export interface TextMapPropagator {
  inject(context: ISpanContext, carrier: Record<string, string>): void;
  extract(carrier: HeaderCarrier): ISpanContext | null;
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
    const traceFlags = (context.traceFlags ?? 0).toString(16).padStart(2, '0');
    const traceparent = `${version}-${context.traceId}-${context.spanId}-${traceFlags}`;
    carrier[W3CTraceContextPropagator.TRACE_PARENT_HEADER] = traceparent;

    if (context.traceState) {
      carrier[W3CTraceContextPropagator.TRACE_STATE_HEADER] = context.traceState;
    }
  }

  /**
   * Extract trace context from carrier
   */
  public extract(carrier: HeaderCarrier): ISpanContext | null {
    const traceparent = this.getHeader(carrier, W3CTraceContextPropagator.TRACE_PARENT_HEADER);
    if (!traceparent) {
      return null;
    }

    const parsed = parseTraceParent(traceparent);
    if (!parsed) {
      return null;
    }

    const traceState = this.getHeader(carrier, W3CTraceContextPropagator.TRACE_STATE_HEADER);

    return {
      traceId: parsed.traceId,
      spanId: parsed.spanId,
      traceFlags: parsed.traceFlags,
      traceState: traceState || undefined,
    };
  }

  private getHeader(carrier: HeaderCarrier, name: string): string | null {
    if (!carrier || typeof carrier !== 'object') {
      return null;
    }

    const direct = carrier[name];
    if (typeof direct === 'string') return direct;
    if (Array.isArray(direct)) {
      const valid = direct.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      if (valid.length > 0) {
        return name.toLowerCase() === W3CTraceContextPropagator.TRACE_STATE_HEADER
          ? valid.join(',')
          : valid[0];
      }
    }

    const lowerName = name.toLowerCase();
    for (const key of Object.keys(carrier)) {
      if (key.toLowerCase() === lowerName) {
        const val = carrier[key];
        if (typeof val === 'string') return val;
        if (Array.isArray(val)) {
          const valid = val.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
          if (valid.length > 0) {
            return lowerName === W3CTraceContextPropagator.TRACE_STATE_HEADER
              ? valid.join(',')
              : valid[0];
          }
        }
      }
    }

    return null;
  }
}
