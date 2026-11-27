/**
 * JSON for values `JSON.stringify` throws on: a BigInt, a circular object, or an object holding
 * either. Anything `JSON.stringify` already encodes keeps the same bytes. `safeStringify` (span
 * attributes) and `jsonSafe` (a check's input) handle failures differently; both outputs are on the
 * wire, so each keeps its own algorithm.
 */

/** How many containers deep a value is read, counting the outer one; deeper ones are cut off. */
export const MAX_DEPTH = 32;

/** An object literal or Object.create(null) from this realm; another realm's literal is not one. */
function isOwnRealmPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

function ctorName(v: object): string {
  try {
    const proto = Object.getPrototypeOf(v) as { constructor?: { name?: string } } | null;
    return proto?.constructor?.name || 'Object';
  } catch {
    return 'Object';
  }
}

/**
 * `JSON.stringify(value)` that never throws: a BigInt becomes its digits as a string and a
 * circular reference `"[Circular]"`. Functions and symbols are dropped as `JSON.stringify`
 * drops them.
 */
export function safeStringify(value: unknown): string | undefined {
  const ancestors: unknown[] = [];
  try {
    return JSON.stringify(value, function (this: unknown, _key: string, val: unknown) {
      if (typeof val === 'bigint') return val.toString();
      if (val === null || typeof val !== 'object') return val;
      // `this` is the object holding `val`: drop the ancestors we have left.
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(val)) return '[Circular]';
      ancestors.push(val);
      return val;
    });
  } catch {
    return '"[unserializable]"'; // e.g. a throwing getter or toJSON
  }
}

/**
 * A check's `context.input` in a form axios can send. Input `JSON.stringify` can encode is
 * returned as is (same object, same bytes). Otherwise, within it: a BigInt becomes a
 * string, a circular reference `"[Circular]"`, and an object that is not plain, an array or
 * a Date and still cannot be encoded `"<ClassName>"`. Never its `String()`, which could
 * hold secrets.
 */
export function jsonSafe(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return sanitize(value, [], 0);
  }
}

function sanitize(v: unknown, ancestors: object[], depth: number): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v !== 'object') return v; // JSON.stringify drops functions/symbols
  if (ancestors.includes(v)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '<…>';
  try {
    const hasToJSON = typeof (v as { toJSON?: unknown }).toJSON === 'function';
    if (!hasToJSON && (Array.isArray(v) || isOwnRealmPlainObject(v))) {
      ancestors.push(v);
      try {
        if (Array.isArray(v)) return v.map((x) => sanitize(x, ancestors, depth + 1));
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v)) {
          // defineProperty: an own "__proto__" stays a plain key
          Object.defineProperty(out, k, {
            value: sanitize(v[k], ancestors, depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return out;
      } finally {
        ancestors.pop();
      }
    }
    JSON.stringify(v); // a Date, or another object with a working JSON form
    return v;
  } catch {
    return `<${ctorName(v)}>`;
  }
}
