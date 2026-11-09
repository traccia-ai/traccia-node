/**
 * Canonical idempotency keys for tool calls, and `idempotencyKey()`, which returns the key of the
 * call running now. Keys must match the Python SDK byte for byte (see
 * __tests__/fixtures/idempotency_vectors.json).
 */

import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import { MAX_DEPTH } from '../utils/json-safe'; // deriveKey's material uses two of these levels

export const KEY_PREFIX = 'idk1_';
/** A whole key: the prefix and a lowercase hex SHA-256. */
export const KEY_PATTERN = new RegExp(`^${KEY_PREFIX}[0-9a-f]{64}$`);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const KEY_TYPES = ['string', 'number', 'boolean'] as const;
export type KeyType = (typeof KEY_TYPES)[number];
const PLAIN_NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;
// keyTypes numbers whose exponent is beyond this stay text (the Python SDK's bound for Decimal).
const MAX_DECIMAL_EXPONENT = 400;
// What keyTypes trims around a value (see trimKeySpace): space, \t, \n, \v, \f, \r.
const KEY_SPACE = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

/** The arguments cannot be turned into a stable idempotency key. */
export class Unkeyable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Unkeyable';
  }
}

function nfc(s: string, reason: string): string {
  if (LONE_SURROGATE.test(s)) throw new Unkeyable(reason);
  return s.normalize('NFC');
}

function kindOf(v: unknown): string {
  if (typeof v !== 'object') return typeof v;
  const proto = Object.getPrototypeOf(v) as { constructor?: { name?: string } } | null;
  return proto?.constructor?.name || 'object';
}

/**
 * A plain object: an object literal, Object.create(null), or a literal from another realm (a vm
 * context or an iframe has its own Object.prototype), so a tool called across realms keys the
 * same as one called here.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as object | null;
  if (proto === Object.prototype || proto === null) return true;
  // Another realm's Object.prototype: the root of its chain, with its own constructor named Object.
  if (Object.getPrototypeOf(proto) !== null || !Object.prototype.hasOwnProperty.call(proto, 'constructor')) return false;
  const ctor = (proto as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor.name === 'Object' && Object.prototype.toString.call(v) === '[object Object]';
}

/**
 * A small number in plain digits: '1.5e-7' -> '0.00000015'. JS switches to exponents below 1e-6
 * and Python below 1e-4, with the same digits, so both spell them out. Only non-integers reach
 * here, and those are all below 2**53, so only negative exponents occur.
 */
function plainDigits(text: string): string {
  const m = /^(-?)(\d)(?:\.(\d+))?e-(\d+)$/.exec(text);
  if (!m) return text;
  const [, sign, lead, rest = '', exp] = m;
  return `${sign}0.${'0'.repeat(Number(exp) - 1)}${lead}${rest}`;
}

/** A number coerced from a plain decimal string, kept as normalized digits so none are lost. */
class KeyNumber {
  constructor(readonly text: string) {}
}

/** The exponent of a normalized plain decimal in scientific notation: 1234.5 -> 3, 0.001 -> -3, 0 -> 0. */
function decimalExponent(digits: string): number {
  const [int, frac = ''] = digits.replace(/^-/, '').split('.');
  if (/[1-9]/.test(int)) return int.length - 1;
  const lead = frac.search(/[1-9]/);
  return lead < 0 ? 0 : -(lead + 1);
}

/** '007.50' -> '7.5', '-0.00' -> '0': the digits a Python Decimal of the same text keys as. */
function normalizeDecimal(text: string): string {
  const negative = text.startsWith('-');
  const [rawInt, rawFrac = ''] = (negative ? text.slice(1) : text).split('.');
  const int = rawInt.replace(/^0+(?=\d)/, '');
  // An index loop, not /0+$/: that regex retries from every zero, quadratic in a long run of zeros.
  let end = rawFrac.length;
  while (end > 0 && rawFrac.charCodeAt(end - 1) === 48) end--;
  const frac = rawFrac.slice(0, end);
  const digits = frac ? `${int}.${frac}` : int;
  return negative && /[1-9]/.test(digits) ? `-${digits}` : digits;
}

function coerce(value: unknown, kind: KeyType): unknown {
  if (kind === 'string') {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number' && Number.isFinite(value)) return enc(value, '', 0); // 123 -> '123'
    return value;
  }
  if (kind === 'number') {
    if (typeof value === 'string' && PLAIN_NUMBER.test(trimKeySpace(value))) {
      const digits = normalizeDecimal(trimKeySpace(value));
      // Beyond the bound it stays text, as in the Python SDK: keyTypes never makes a call unkeyable.
      return Math.abs(decimalExponent(digits)) <= MAX_DECIMAL_EXPONENT ? new KeyNumber(digits) : value;
    }
    return value;
  }
  if (typeof value === 'string' && ['true', 'false'].includes(trimKeySpace(value).toLowerCase())) {
    return trimKeySpace(value).toLowerCase() === 'true';
  }
  return value;
}

/**
 * What keyTypes trims around a value: ASCII whitespace only, the same set as the Python SDK.
 * trim() also strips U+FEFF, and Python's str.strip() strips U+0085 and U+001C-001F, so neither
 * is used.
 */
function trimKeySpace(value: string): string {
  // Index loops, not a regex: /[ \t...]+$/ retries from every inner run of spaces, quadratic in
  // a long model-chosen value.
  let start = 0;
  let end = value.length;
  while (start < end && KEY_SPACE.has(value.charCodeAt(start))) start++;
  while (end > start && KEY_SPACE.has(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

/**
 * `args` with the named fields converted to their declared type, for the key only: a model sends
 * 123 one time and '123' the next, or '10.50' for 10.5. `string` turns a number into its canonical
 * text; `number` turns a plain decimal string (ASCII digits, optional sign and fraction, no
 * exponent) into a number; `boolean` turns 'true'/'false' into a boolean. Anything else is left
 * as it is. The same rules as the Python SDK's coerce_key_types.
 */
export function coerceKeyTypes(
  args: Record<string, unknown>,
  keyTypes: Record<string, KeyType> | undefined,
): Record<string, unknown> {
  if (!keyTypes) return args;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>; // an own "__proto__" stays a plain key
  for (const k of Object.keys(args)) out[k] = args[k];
  for (const [name, kind] of Object.entries(keyTypes)) {
    if (Object.prototype.hasOwnProperty.call(out, name)) out[name] = coerce(out[name], kind);
  }
  return out;
}

function enc(v: unknown, path: string, depth: number): string {
  const where = path || 'value';
  if (v === null || v === undefined) return 'null'; // undefined only reaches here as an array item
  if (v instanceof KeyNumber) return v.text;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Unkeyable(`${where} is ${v}`);
    if (Number.isInteger(v)) {
      // The exact digits of the double, like Python str(int(v)): the same on both sides even
      // beyond 2**53 (where the number may already have rounded an id; pass those as strings).
      return BigInt(v).toString();
    }
    return plainDigits(String(v)); // same shortest digits as Python repr()
  }
  if (typeof v === 'string') return JSON.stringify(nfc(v, `${where} has a lone surrogate`));
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new Unkeyable(`${where} is an invalid Date`);
    const year = v.getUTCFullYear(); // Python datetimes only cover years 1-9999
    if (year < 1 || year > 9999) throw new Unkeyable(`${where} is a Date outside the UTC range`);
    return JSON.stringify(v.toISOString());
  }
  const isArray = Array.isArray(v);
  if (!isArray && !isPlainObject(v)) throw new Unkeyable(`${where} is ${kindOf(v)}`);
  if (depth >= MAX_DEPTH) throw new Unkeyable(`${where} is nested more than ${MAX_DEPTH} levels deep`);
  if (!isArray) return object(v, path, where, depth + 1);
  const items: string[] = [];
  const arr = v as unknown[];
  for (let i = 0; i < arr.length; i++) items.push(enc(arr[i], `${path}[${i}]`, depth + 1));
  return '[' + items.join(',') + ']';
}

function rejectSymbolKeys(o: object, where: string): void {
  if (Object.getOwnPropertySymbols(o).some((s) => Object.prototype.propertyIsEnumerable.call(o, s))) {
    throw new Unkeyable(`${where} has a symbol key`);
  }
}

function object(o: Record<string, unknown>, path: string, where: string, depth: number): string {
  rejectSymbolKeys(o, where);
  const items = new Map<string, unknown>();
  for (const k of Object.keys(o)) {
    const val = o[k]; // read once: a getter must not change between the check and the encoding
    if (val === undefined) continue; // like JSON.stringify
    const key = nfc(k, `${where} has a key with a lone surrogate`);
    if (items.has(key)) throw new Unkeyable(`${where} has two keys that are equal after NFC normalization`);
    items.set(key, val);
  }
  // Code point order == UTF-8 byte order; the default sort would use UTF-16 units.
  const keys = [...items.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return '{' + keys.map(
    (k) => JSON.stringify(k) + ':' + enc(items.get(k), path ? `${path}.${k}` : k, depth),
  ).join(',') + '}';
}

/**
 * @internal Canonical JSON for `value`; throws `Unkeyable` if it has no stable form. For tests:
 * `deriveKey` encodes its parts itself, so its messages name an argument without an `args.` prefix.
 */
export function canonicalJson(value: unknown): string {
  return enc(value, '', 0);
}

const warnedMissing = new Set<string>();

function warnMissingOnce(tool: string, name: string): void {
  const id = JSON.stringify([tool, name]);
  if (warnedMissing.has(id)) return;
  warnedMissing.add(id);
  console.warn(
    `[traccia] idempotent tool '${tool}': keyFields names '${name}', which this call does not have, ` +
      `so it is left out of the key; write '${name}?' if it may be left out, or fix the name`,
  );
}

/**
 * An `Unkeyable` for an error thrown while keying a call (a throwing getter or keyExtra, a Proxy
 * trap). Its message may hold raw values (a tenant id, an account), so only its type is kept.
 */
export function unkeyableFrom(error: unknown, doing: string): Unkeyable {
  const type = (error as { constructor?: { name?: string } } | null | undefined)?.constructor?.name || 'Error';
  return new Unkeyable(`${type} while ${doing}`);
}

/** @internal Forget which missing key fields were already warned about. */
export function _resetMissingFieldWarningsForTests(): void {
  warnedMissing.clear();
}

/**
 * `idk1_` + SHA-256 of the canonical call. Top-level null/undefined arguments are dropped.
 * `extra` (a tool's `keyExtra`: inputs that are not arguments, such as the account on `this` or
 * the current tenant) adds an `"extra"` member; null/undefined adds nothing, so keys without it
 * are unchanged.
 */
export function deriveKey(
  agentId: string | undefined | null,
  tool: string,
  args: Record<string, unknown>,
  keyFields?: string[],
  extra?: unknown,
): string {
  if (!keyFields) rejectSymbolKeys(args, 'value'); // Object.keys would silently skip them
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(args, k) as boolean;
  let names: string[];
  if (!keyFields) {
    names = Object.keys(args);
  } else {
    names = [];
    for (const field of keyFields) {
      // 'cc?' marks a field that may be left out; any other field must be in the call.
      const optional = field.endsWith('?');
      const name = optional ? field.slice(0, -1) : field;
      if (has(name)) names.push(name);
      else if (!optional) {
        // Left out, like 'cc?', so whether the call is keyable never depends on what this one
        // call happened to carry; a warning still points at a typo.
        warnMissingOnce(tool, name);
      }
    }
  }
  const pick = (from: string[]): Record<string, unknown> => {
    const kept: Record<string, unknown> = Object.create(null) as Record<string, unknown>; // an own "__proto__" stays a plain key
    for (const k of from) {
      const val = args[k]; // read once, as in the object encoder
      if (val !== null && val !== undefined) kept[k] = val;
    }
    return kept;
  };
  // When no key field has a value (left out, null or undefined), the selection is empty and every
  // such call shares one key: keyFields says only those fields tell calls apart, so a changing
  // request id or timestamp cannot slip a repeat past. A mistyped name is still warned about.
  const kept = pick(names);
  const agent = enc(agentId ?? '', 'agent', 1);
  const extraMember = extra === undefined || extra === null ? '' : `,"extra":${enc(extra, 'keyExtra', 1)}`;
  const material = `{"agent":${agent},"args":${enc(kept, '', 1)}${extraMember},"tool":${enc(tool, 'tool', 1)},"v":1}`;
  return KEY_PREFIX + createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * An idempotent tool call running in this async context, by its call key. It is marked done when
 * the call ends: a timer or callback the tool started keeps this async context, and a plain list
 * of keys would still say "running" after the call finished.
 */
export type ActiveCall = { key: string; running: boolean };

/**
 * What `idempotencyKey()` returns (or throws) here, and the idempotent calls running in this
 * async context, outermost first.
 */
type CallScope = { key: string | Unkeyable; active: readonly ActiveCall[] };

const callScope = new AsyncLocalStorage<CallScope>();

/** The key of the idempotent tool call running now. */
export function idempotencyKey(): string {
  const value = callScope.getStore()?.key;
  if (value === undefined) throw new Error('idempotencyKey() called outside an idempotent tool');
  if (value instanceof Unkeyable) throw value;
  return value;
}

/**
 * Run `fn` with `idempotencyKey()` returning `value` (or throwing it), across awaits. `call`, when
 * given, is added to the calls running in this async context.
 */
export function bindKey<T>(value: string | Unkeyable, fn: () => T, call?: ActiveCall): T {
  const active = callScope.getStore()?.active ?? [];
  return callScope.run({ key: value, active: call ? [...active, call] : active }, fn);
}

/** Whether a call with this call key is still running in this async context: the tool called itself. */
export function isRunning(callKey: string): boolean {
  return (callScope.getStore()?.active ?? []).some((c) => c.key === callKey && c.running);
}
