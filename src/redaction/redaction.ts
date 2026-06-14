/**
 * PII redaction - manual helpers and optional automatic span redaction before export.
 */

import { REDACTION_APPLIED } from "../governance/schema";

export { REDACTION_APPLIED };

const EMAIL = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
const PHONE = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

export const DEFAULT_SENSITIVE_KEY_FRAGMENTS: ReadonlySet<string> = new Set([
  "prompt",
  "completion",
  "input",
  "output",
  "message",
  "content",
  "text",
  "body",
  "query",
  "response",
  "user",
  "assistant",
]);

export function redactString(text: string | null | undefined): string {
  if (!text || typeof text !== 'string') return '';
  let result = text;
  result = result.replace(EMAIL, "[REDACTED_EMAIL]");
  result = result.replace(PHONE, "[REDACTED_PHONE]");
  result = result.replace(SSN, "[REDACTED_SSN]");
  return result;
}

function keyIsSensitive(key: string, fragments: Iterable<string>): boolean {
  const lower = key.toLowerCase();
  for (const fragment of fragments) {
    if (lower.includes(fragment.toLowerCase())) {
      return true;
    }
  }
  return false;
}

export function redactValue(
  value: unknown,
  options?: { redactAllStrings?: boolean; key?: string; extraKeyFragments?: ReadonlySet<string> },
): unknown {
  const fragments = options?.extraKeyFragments ?? DEFAULT_SENSITIVE_KEY_FRAGMENTS;
  if (typeof value === "string") {
    if (options?.redactAllStrings || keyIsSensitive(options?.key ?? "", fragments)) {
      return redactString(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, options));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = redactValue(v, { ...options, key: k });
    }
    return result;
  }
  return value;
}

export function redactAttributes(
  attrs: Record<string, unknown> | null | undefined,
  options?: { extraKeyFragments?: Iterable<string>; redactAllStrings?: boolean },
): Record<string, unknown> {
  if (!attrs) return {};
  const fragments = new Set(DEFAULT_SENSITIVE_KEY_FRAGMENTS);
  for (const f of options?.extraKeyFragments ?? []) {
    fragments.add(f);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "string" && (options?.redactAllStrings || keyIsSensitive(key, fragments))) {
      out[key] = redactString(value);
    } else {
      out[key] = redactValue(value, { ...options, key, extraKeyFragments: fragments });
    }
  }
  out[REDACTION_APPLIED] = true;
  return out;
}

export function applyRedactionToSpan(
  span: { attributes?: Record<string, unknown>; setAttribute?: (key: string, value: unknown) => void },
  options?: { extraKeyFragments?: Iterable<string> },
): number {
  if (!span || typeof span.setAttribute !== "function") {
    return 0;
  }
  const raw = { ...(span.attributes ?? {}) };
  if (Object.keys(raw).length === 0) {
    return 0;
  }
  const fragments = new Set(DEFAULT_SENSITIVE_KEY_FRAGMENTS);
  for (const f of options?.extraKeyFragments ?? []) {
    fragments.add(f);
  }
  const redacted = redactAttributes(raw, { extraKeyFragments: fragments });
  let changed = 0;
  for (const [key, value] of Object.entries(redacted)) {
    if (key === REDACTION_APPLIED) continue;
    if (raw[key] !== value) {
      span.setAttribute!(key, value);
      changed++;
    }
  }
  if (changed > 0 || redacted[REDACTION_APPLIED]) {
    span.setAttribute!(REDACTION_APPLIED, true);
  }
  return changed;
}