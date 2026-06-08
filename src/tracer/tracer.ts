/**
 * Tracer implementation for creating and managing spans.
 */

import { ITracer, ISpan, ISpanContext } from '../types';
import { Span } from './span';
import { SpanContext } from './span-context';
import { getCurrentSpan, runWithSpanAsync } from '../context/context';
import { TracerProvider } from './provider';
import { getConfig } from '../config/runtime-config';

/**
 * Tracer for creating and managing spans.
 */
export class Tracer implements ITracer {
  private provider: TracerProvider;

  constructor(provider: TracerProvider, _instrumentationScope: string) {
    this.provider = provider;
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
    const parentSpan = options?.parent ?? getCurrentSpan();
    const effectiveContext = options?.parentContext || (parentSpan?.context as ISpanContext);

    let traceId: string;
    let parentSpanId: string | undefined;
    let traceFlags: number;

    if (parentSpan) {
      traceId = parentSpan.context.traceId;
      parentSpanId = parentSpan.context.spanId;
      traceFlags = parentSpan.context.traceFlags;
    } else if (effectiveContext && effectiveContext.traceId) {
      traceId = effectiveContext.traceId;
      parentSpanId = effectiveContext.spanId;
      traceFlags = effectiveContext.traceFlags || 1;
      console.log(`🔗 TRACCIA PATCH: Continuing trace from parent context: TraceId:${traceId} -> parentSpanId:${parentSpanId}`);
    } else {
      traceId = this.provider.generateTraceId();
      parentSpanId = undefined;

      const sampler = this.provider.getSampler();
      const sampled = sampler ? sampler.shouldSample().sampled : true;
      traceFlags = sampled ? 1 : 0;

      // Debug override: force sampling for new root traces
      const config = getConfig();
      if (config.debug) {
        traceFlags = 1;
      }
    }

    const spanContext = new SpanContext(
      traceId,
      this.provider.generateSpanId(),
      traceFlags,
      effectiveContext?.traceState
    );

    return new Span(name, this, spanContext, parentSpanId, options?.attributes, this.provider);
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
