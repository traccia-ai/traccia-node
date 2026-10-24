/**
 * Context management for spans using async local storage.
 */

import { AsyncLocalStorage } from 'async_hooks';
import {
  context as otelContext,
  trace,
  createTraceState,
  Context,
  ContextManager,
  ROOT_CONTEXT,
} from '@opentelemetry/api';
import { ISpan } from '../types';

/**
 * AsyncLocalStorage-based ContextManager for OpenTelemetry.
 */
export class AsyncLocalStorageContextManager implements ContextManager {
  private storage = new AsyncLocalStorage<Context>();

  public active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  public with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(context, (): ReturnType<F> => (fn.call(thisArg, ...args) as ReturnType<F>));
  }

  public bind<T>(context: Context, target: T): T {
    if (typeof target === 'function') {
      return ((...args: unknown[]): unknown => {
        return this.with(context, target as (...a: unknown[]) => unknown, undefined, ...args);
      }) as unknown as T;
    }
    return target;
  }

  public enable(): this {
    return this;
  }

  public disable(): this {
    this.storage.disable();
    return this;
  }
}

// Automatically register our context manager if one is not already set
otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager());

interface SpanContext {
  span?: ISpan;
}

const CONTEXT_KEY = Symbol.for('traccia.spanContext');

/** One process shares the active span across the CLI bundle and the public SDK. */
function spanContext(): AsyncLocalStorage<SpanContext> {
  const host = globalThis as typeof globalThis & { [CONTEXT_KEY]?: AsyncLocalStorage<SpanContext> };
  if (!host[CONTEXT_KEY]) host[CONTEXT_KEY] = new AsyncLocalStorage();
  return host[CONTEXT_KEY];
}

/**
 * Get the corresponding OpenTelemetry context for a Traccia span.
 */
export function getOtelContextForSpan(span?: ISpan): Context {
  if (!span) {
    return otelContext.active();
  }

  if (span.otelSpan) {
    return trace.setSpan(otelContext.active(), span.otelSpan);
  }

  if (span.context) {
    const traceState = span.context.traceState
      ? (typeof span.context.traceState === 'string'
          ? createTraceState(span.context.traceState)
          : span.context.traceState)
      : undefined;

    return trace.setSpanContext(otelContext.active(), {
      traceId: span.context.traceId,
      spanId: span.context.spanId,
      traceFlags: span.context.traceFlags ?? 1,
      traceState,
    });
  }

  return otelContext.active();
}

/**
 * Get the current span from context.
 */
export function getCurrentSpan(): ISpan | undefined {
  const ctx = spanContext().getStore();
  return ctx?.span;
}

/**
 * Set the current span in context.
 */
export function setCurrentSpan(span: ISpan | undefined): void {
  const ctx = spanContext().getStore() || {};
  ctx.span = span;
  spanContext().enterWith(ctx);
}

/**
 * Run a function with a specific span as the current span.
 */
export function runWithSpan<T>(span: ISpan, fn: () => T): T {
  const otelCtx = getOtelContextForSpan(span);
  return otelContext.with(otelCtx, () => spanContext().run({ span }, fn));
}

/**
 * Run a function with a specific span as the current span (async).
 */
export function runWithSpanAsync<T>(span: ISpan, fn: () => Promise<T>): Promise<T> {
  const otelCtx = getOtelContextForSpan(span);
  return otelContext.with(otelCtx, () => spanContext().run({ span }, fn));
}

/**
 * Get the current context store.
 */
export function getContext(): SpanContext {
  return spanContext().getStore() || {};
}
