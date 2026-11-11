/**
 * PII / best-effort PHI redaction - manual helpers and optional automatic span redaction before export.
 * Regex only — not a guarantee that all PHI is removed.
 */

import { REDACTION_APPLIED } from "../governance/schema";

export { REDACTION_APPLIED };

const EMAIL = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g;
const PHONE = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const MRN = /\b(?:MRN|mrn)[:\s#=-]*([A-Za-z0-9-]{4,})\b/g;
const NPI = /\b(?:NPI|npi)[:\s#=-]*(\d{10})\b/g;
const DOB =
  /\b(?:DOB|dob|date of birth)[:\s=-]*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/gi;
const MEDICARE = /\b\d{4}-\d{4}-\d{4}\b/g;

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
  "result",
  "exception",
  "error",
  "user",
  "assistant",
  "phi",
  "clinical",
  "patient",
  "diagnosis",
  "medication",
]);

/** Prompt identity attrs contain substring "prompt" but must not be redacted. */
export const PROMPT_IDENTITY_KEY_PREFIX = "traccia.prompt.";
const EVAL_ALLOWLIST_PREFIXES = [
  "traccia.prompt.",
  "traccia.policy.",
  "traccia.experiment.",
  "traccia.eval.",
  "traccia.dataset.",
];

function keyIsAllowlisted(key: string): boolean {
  const lower = key.toLowerCase();
  return EVAL_ALLOWLIST_PREFIXES.some((p) => lower.startsWith(p));
}

function keyIsSensitive(key: string, fragments: Iterable<string>): boolean {
  if (keyIsAllowlisted(key)) {
    return false;
  }
  const lower = key.toLowerCase();
  for (const fragment of fragments) {
    if (lower.includes(fragment.toLowerCase())) {
      return true;
    }
  }
  return false;
}

export function redactString(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";
  let result = text;
  result = result.replace(EMAIL, "[REDACTED_EMAIL]");
  // Labeled PHI heuristics before generic phone/SSN so "NPI 1234567890" is not treated as a phone
  result = result.replace(MRN, "MRN:[REDACTED_MRN]");
  result = result.replace(NPI, "NPI:[REDACTED_NPI]");
  result = result.replace(DOB, "DOB:[REDACTED_DOB]");
  result = result.replace(PHONE, "[REDACTED_PHONE]");
  result = result.replace(SSN, "[REDACTED_SSN]");
  result = result.replace(MEDICARE, "[REDACTED_ID]");
  return result;
}

/**
 * Redact a value recursively. Strings are redacted when `redactAllStrings` is set or
 * when their key, or any ancestor key, is sensitive (so `{ result: { answer } }` is covered).
 */
export function redactValue(
  value: unknown,
  options?: {
    redactAllStrings?: boolean;
    key?: string;
    extraKeyFragments?: ReadonlySet<string>;
    /** Internal: an ancestor key was sensitive. */
    sensitive?: boolean;
  },
): unknown {
  const fragments = options?.extraKeyFragments ?? DEFAULT_SENSITIVE_KEY_FRAGMENTS;
  const sensitive =
    !!options?.sensitive || !!options?.redactAllStrings || keyIsSensitive(options?.key ?? "", fragments);
  if (typeof value === "string") {
    return sensitive ? redactString(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, { ...options, sensitive }));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = redactValue(v, { ...options, key: k, sensitive });
    }
    return result;
  }
  return value;
}

/**
 * Attributes holding JSON-serialized guardrail findings or summaries. A finding's
 * `raw_excerpt` copies text from the span (a completion, an error message), so these are
 * decoded and their excerpts scrubbed like the attribute they came from. This covers the
 * per-span findings and the root span's aggregate of every finding in the trace.
 */
const GUARDRAIL_JSON_KEYS: ReadonlySet<string> = new Set(["guardrail.findings", "guardrail.summary"]);

function redactGuardrailJson(
  value: unknown,
  options: { redactAllStrings?: boolean; extraKeyFragments: ReadonlySet<string> },
): unknown {
  if (typeof value !== "string") {
    return value;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    // Not the JSON the detector writes: treat the whole value as content.
    return redactString(value);
  }
  const fragments = new Set(options.extraKeyFragments);
  fragments.add("excerpt");
  const scrubbed = redactValue(decoded, {
    redactAllStrings: options.redactAllStrings,
    extraKeyFragments: fragments,
  });
  const encoded = JSON.stringify(scrubbed);
  // Keep the original bytes when nothing was scrubbed.
  return encoded === JSON.stringify(decoded) ? value : encoded;
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
    if (keyIsAllowlisted(key)) {
      out[key] = value;
      continue;
    }
    if (GUARDRAIL_JSON_KEYS.has(key)) {
      out[key] = redactGuardrailJson(value, { ...options, extraKeyFragments: fragments });
      continue;
    }
    out[key] = redactValue(value, { ...options, key, extraKeyFragments: fragments });
  }
  out[REDACTION_APPLIED] = true;
  return out;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

type RedactableSpan = {
  attributes?: Record<string, unknown>;
  events?: Array<{ attributes?: Record<string, unknown> }>;
  statusDescription?: string;
  setAttribute?: (key: string, value: unknown) => void;
};

/**
 * Redact attributes, buffered events (including exceptions) and the status
 * description on a mutable span. Returns the number of fields changed.
 * With `setUnchanged`, primitive attributes are re-set even when unchanged.
 */
export function applyRedactionToSpan(
  span: RedactableSpan,
  options?: { extraKeyFragments?: Iterable<string>; redactAllStrings?: boolean; setUnchanged?: boolean },
): number {
  if (!span || typeof span.setAttribute !== "function") {
    return 0;
  }
  const redactOpts = { extraKeyFragments: options?.extraKeyFragments, redactAllStrings: options?.redactAllStrings };
  let changed = 0;

  const raw = { ...(span.attributes ?? {}) };
  const hasAttrs = Object.keys(raw).length > 0;
  if (hasAttrs) {
    const redacted = redactAttributes(raw, redactOpts);
    for (const [key, value] of Object.entries(redacted)) {
      if (key === REDACTION_APPLIED) continue;
      if (!valuesEqual(raw[key], value)) {
        span.setAttribute!(key, value);
        changed++;
      } else if (
        options?.setUnchanged &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      ) {
        span.setAttribute!(key, value);
      }
    }
  }

  for (const event of Array.isArray(span.events) ? span.events : []) {
    if (!event?.attributes || Object.keys(event.attributes).length === 0) continue;
    const redacted = redactAttributes(event.attributes, redactOpts);
    delete redacted[REDACTION_APPLIED];
    if (!valuesEqual(event.attributes, redacted)) {
      event.attributes = redacted;
      changed++;
    }
  }

  // Error status descriptions are exception messages: always scrub them.
  if (typeof span.statusDescription === "string" && span.statusDescription) {
    const scrubbed = redactString(span.statusDescription);
    if (scrubbed !== span.statusDescription) {
      span.statusDescription = scrubbed;
      changed++;
    }
  }

  if (hasAttrs || changed > 0) {
    span.setAttribute!(REDACTION_APPLIED, true);
  }
  return changed;
}
