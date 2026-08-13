/**
 * Local ports of platform deterministic scorers.
 */

export const BUILTIN_SCORERS = new Set(['exact_match', 'contains', 'json_valid']);

function normalizeText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value).trim();
}

function stamped(name: string, rec: Record<string, unknown>): Record<string, unknown> {
  return { ...rec, name, scorer_name: name, type: name };
}

export function runBuiltinScorer(
  name: string,
  opts: { output: unknown; expected?: unknown; config?: Record<string, unknown> },
): Record<string, unknown> {
  const config = opts.config || {};
  const caseSensitive = Boolean(config.case_sensitive);

  if (name === 'exact_match') {
    if (opts.expected == null) {
      return stamped(name, { passed: false, reason: 'missing_expected_output', score: 0 });
    }
    let a = normalizeText(opts.output);
    let e = normalizeText(opts.expected);
    if (!caseSensitive) {
      a = a.toLowerCase();
      e = e.toLowerCase();
    }
    const passed = a === e;
    return stamped(name, { passed, reason: passed ? null : 'mismatch', score: passed ? 1 : 0 });
  }

  if (name === 'contains') {
    if (opts.expected == null) {
      return stamped(name, { passed: false, reason: 'missing_expected_output', score: 0 });
    }
    let a = normalizeText(opts.output);
    let e = normalizeText(opts.expected);
    if (!caseSensitive) {
      a = a.toLowerCase();
      e = e.toLowerCase();
    }
    if (!e) return stamped(name, { passed: false, reason: 'empty_expected', score: 0 });
    const passed = a.includes(e);
    return stamped(name, { passed, reason: passed ? null : 'not_found', score: passed ? 1 : 0 });
  }

  if (name === 'json_valid') {
    if (opts.output && typeof opts.output === 'object') {
      return stamped(name, { passed: true, reason: null, score: 1 });
    }
    if (typeof opts.output !== 'string') {
      return stamped(name, { passed: false, reason: 'not_json', score: 0 });
    }
    const text = opts.output.trim();
    if (!text) return stamped(name, { passed: false, reason: 'empty', score: 0 });
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        return stamped(name, { passed: true, reason: null, score: 1 });
      }
      return stamped(name, { passed: false, reason: 'not_object_or_array', score: 0 });
    } catch {
      return stamped(name, { passed: false, reason: 'parse_error', score: 0 });
    }
  }

  throw new Error(`Unknown builtin scorer: ${name}`);
}
