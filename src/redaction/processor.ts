/**
 * Span processor that redacts sensitive PII from spans before export.
 */

import { ISpan, ISpanProcessor } from "../types";
import { redactAttributes, DEFAULT_SENSITIVE_KEY_FRAGMENTS, REDACTION_APPLIED } from "./redaction";

export interface RedactionSpanProcessorOptions {
  extraKeyFragments?: Iterable<string>;
  redactAllStrings?: boolean;
}

export class RedactionSpanProcessor implements ISpanProcessor {
  private readonly extraKeyFragments?: Iterable<string>;

  constructor(options?: RedactionSpanProcessorOptions) {
    this.extraKeyFragments = options?.extraKeyFragments;
  }

  onEnd(span: ISpan): void {
    if (!span || typeof span.setAttribute !== "function") {
      return;
    }
    const attrs = span.attributes;
    if (!attrs || Object.keys(attrs).length === 0) {
      return;
    }
    const fragments = new Set(DEFAULT_SENSITIVE_KEY_FRAGMENTS);
    for (const f of this.extraKeyFragments ?? []) {
      fragments.add(f);
    }
    const redacted = redactAttributes(attrs, { extraKeyFragments: fragments });
    for (const [key, value] of Object.entries(redacted)) {
      if (key === REDACTION_APPLIED) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        span.setAttribute(key, value);
      }
    }
    span.setAttribute(REDACTION_APPLIED, true);
  }

  shutdown(): void {
    // No-op
  }

  forceFlush(_timeout?: number): void {
    // No-op
  }
}