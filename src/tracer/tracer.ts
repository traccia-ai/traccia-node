/**
 * Tracer implementation for creating and managing spans.
 */

import {
  trace,
  Tracer as OTelTracer,
  context as otelContext,
  SpanOptions as OTelSpanOptions,
  ROOT_CONTEXT,
  createTraceState,
} from '@opentelemetry/api';
import { ITracer, ISpan, ISpanContext } from '../types';
import { Span } from './span';
import { runWithSpanAsync, getCurrentSpan, getOtelContextForSpan } from '../context/context';
import { TracerProvider } from './provider';

/**
 * Tracer for creating and managing spans.
 */
export class Tracer implements ITracer {
  private provider: TracerProvider;
  private otelTracer: OTelTracer;

  public constructor(provider: TracerProvider, instrumentationScope: string) {
    this.provider = provider;
    // Get native OTel tracer
    this.otelTracer = trace.getTracer(instrumentationScope);
  }

  /**
   * Start a new span.
   */
  public startSpan(
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
      const traceState = options.parentContext.traceState
        ? (typeof options.parentContext.traceState === 'string'
            ? createTraceState(options.parentContext.traceState)
            : options.parentContext.traceState)
        : undefined;

      activeContext = trace.setSpanContext(activeContext, {
        traceId: options.parentContext.traceId,
        spanId: options.parentContext.spanId,
        traceFlags: options.parentContext.traceFlags ?? 1,
        traceState,
        isRemote: true,
      });
    } else if (options?.parent) {
      activeContext = getOtelContextForSpan(options.parent);
    } else if (options?.parent === null) {
      // Explicitly detach from current active span context
      activeContext = ROOT_CONTEXT;
    } else {
      // Automatically pull parent from Traccia context if available
      const currentSpan = getCurrentSpan();
      if (currentSpan) {
        activeContext = getOtelContextForSpan(currentSpan);
      }
    }

    const otelOptions: OTelSpanOptions = {
      attributes: options?.attributes as OTelSpanOptions['attributes'],
    };

    const otelSpan = this.otelTracer.startSpan(name, otelOptions, activeContext);
    const parentSpanId = trace.getSpanContext(activeContext)?.spanId;

    return new Span(name, otelSpan, this.provider, parentSpanId, options?.attributes);
  }

  /**
   * Start an active span and run a function within it.
   */
  public async startActiveSpan<T = unknown>(
    name: string,
    fn: (span: ISpan) => Promise<T> | T,
    options?: {
      attributes?: Record<string, unknown>;
      parent?: ISpan | null;
      parentContext?: ISpanContext | null;
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
