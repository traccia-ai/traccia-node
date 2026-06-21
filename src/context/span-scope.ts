/**
 * Manual span scope — mirrors traccia-py `span()` for long-lived scopes (e.g. streaming).
 */

import { getTracer } from "../auto";
import { ISpan } from "../types";
import { runWithSpan, runWithSpanAsync } from "./context";

export interface SpanScope {
  span: ISpan;
  end(error?: unknown): void;
  run<T>(fn: () => T): T;
  runAsync<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SpanScopeOptions {
  attributes?: Record<string, unknown>;
  parent?: ISpan | null;
  tracerName?: string;
}

/**
 * Start a span with explicit lifecycle control.
 *
 * Unlike `startActiveSpan`, the span is not ended automatically — call `scope.end()`.
 * Use `scope.run` / `scope.runAsync` to run code with this span as the active parent.
 */
export function spanScope(
  name: string,
  options?: SpanScopeOptions,
): SpanScope {
  const tracer = getTracer(options?.tracerName ?? "traccia");
  const span = tracer.startSpan(name, {
    attributes: options?.attributes,
    parent: options?.parent,
  });
  let ended = false;

  return {
    span,
    end(error?: unknown) {
      if (ended) {
        return;
      }
      ended = true;
      if (error instanceof Error) {
        span.recordException(error);
      } else if (error != null) {
        span.recordException(new Error(String(error)));
      }
      span.end();
    },
    run<T>(fn: () => T): T {
      return runWithSpan(span, fn);
    },
    runAsync<T>(fn: () => Promise<T>): Promise<T> {
      return runWithSpanAsync(span, fn);
    },
  };
}
