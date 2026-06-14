/**
 * Tracer implementation for creating and managing spans.
 */

import { trace, Tracer as OTelTracer, context as otelContext, SpanOptions as OTelSpanOptions, ROOT_CONTEXT } from '@opentelemetry/api';
import { ITracer, ISpan, ISpanContext } from '../types';
import { Span } from './span';
import { runWithSpanAsync, getCurrentSpan } from '../context/context';
import { TracerProvider } from './provider';

/**
 * Tracer for creating and managing spans.
 */
export class Tracer implements ITracer {
  private provider: TracerProvider;
  private otelTracer: OTelTracer;

  constructor(provider: TracerProvider, instrumentationScope: string) {
    this.provider = provider;
    // Get native OTel tracer
    this.otelTracer = trace.getTracer(instrumentationScope);
  }

  /**
   * Start a new span.
   */
  startSpan(
    name: string,
    options?: {
      attributes?: Record<string, unknown>;
      parent?: ISpan | null;
      parentContext?: ISpanContext | null;
    }
  ): ISpan {
    let activeContext = otelContext.active();

    if (options?.parentContext) {
      // Create a remote span context and set it as active
      activeContext = trace.setSpanContext(activeContext, {
        traceId: options.parentContext.traceId,
        spanId: options.parentContext.spanId,
        traceFlags: options.parentContext.traceFlags || 1,
        isRemote: true
      });
      console.log(`🔗 TRACCIA PATCH: Continuing trace from parent context: TraceId:${options.parentContext.traceId} -> parentSpanId:${options.parentContext.spanId}`);
    } else if (options?.parent) {
      activeContext = trace.setSpanContext(activeContext, {
        traceId: options.parent.context.traceId,
        spanId: options.parent.context.spanId,
        traceFlags: options.parent.context.traceFlags || 1,
        isRemote: false
      });
    } else if (options?.parent === null) {
      // Explicitly detach from current active span context
      activeContext = ROOT_CONTEXT;
    } else {
      // Automatically pull parent from Traccia context if available
      const currentSpan = getCurrentSpan();
      if (currentSpan) {
        activeContext = trace.setSpanContext(activeContext, {
          traceId: currentSpan.context.traceId,
          spanId: currentSpan.context.spanId,
          traceFlags: currentSpan.context.traceFlags || 1,
          isRemote: false
        });
      }
    }

    const otelOptions: OTelSpanOptions = {
      attributes: options?.attributes as any,
    };

    const otelSpan = this.otelTracer.startSpan(name, otelOptions, activeContext);
    const parentSpanId = trace.getSpanContext(activeContext)?.spanId;

    return new Span(name, otelSpan, this.provider, parentSpanId, options?.attributes);
  }

  /**
   * Start an active span and run a function within it.
   */
  async startActiveSpan<T = unknown>(
    name: string,
    fn: (span: ISpan) => Promise<T> | T,
    options?: {
      attributes?: Record<string, unknown>;
      parent?: ISpan | null;
    }
  ): Promise<T> {
    const span = this.startSpan(name, options);

    try {
      const result = await runWithSpanAsync(span, async () => {
        return await Promise.resolve(fn(span));
      });
      return result;
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  }
}
