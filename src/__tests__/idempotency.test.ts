/**
 * Canonical idempotency keys and the unconfirmed-error classifier: the shared vectors, then what
 * only Node can express (bigint, undefined, symbols, getters, other realms, error shapes). The
 * table names mirror the Python SDK's tests/test_idempotency.py.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import {
  Unkeyable,
  _resetMissingFieldWarningsForTests,
  coerceKeyTypes,
  canonicalJson,
  deriveKey,
  idempotencyKey,
  isUnconfirmed,
  bindKey,
} from '../governance/idempotency';
import * as sdk from '../index';

const VECTOR_FILE = path.join(__dirname, 'fixtures', 'idempotency_vectors.json');
// The Python SDK checkout: TRACCIA_PY_DIR (absolute, or relative to this repo), else the sibling traccia-py.
const PYTHON_VECTOR_FILE = [process.env.TRACCIA_PY_DIR || path.join('..', 'traccia-py')]
  .map((dir) => path.resolve(__dirname, '..', '..', dir, 'tests', 'fixtures', 'idempotency_vectors.json'))
  .find((file) => fs.existsSync(file));
// sha256 of the shared vector file (LF line endings). Update it together with the Python copy.
const VECTOR_SHA256 = 'f2e98b6f8db27fedc3c0569f4b4e3e5b97e61784b27029249618d40b0c7e1def';

interface Case {
  name: string;
  agent: string | null;
  tool: string;
  args: Record<string, unknown>;
  key_fields?: string[];
  key_types?: Record<string, 'string' | 'number' | 'boolean'>;
  extra?: unknown;
  canonical?: string;
  unkeyable?: boolean;
  python_only?: boolean;
}

const VECTORS: { version: number; cases: Case[] } = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf8'));
const SHARED = VECTORS.cases.filter((c) => !c.python_only);

/** sha256 of a file, ignoring a CRLF checkout (git autocrlf) so Windows and CI agree. */
function fileSha(file: string): string {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const sha = (text: string) => 'idk1_' + createHash('sha256').update(text, 'utf8').digest('hex');

/** Turn the vector file's `$tag` objects into native JS values. */
function native(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(native);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([k]) => k.startsWith('$'))) {
    if (entries.length !== 1) throw new Error(`tag mixed with other keys: ${Object.keys(value).join(',')}`);
    const [tag, raw] = entries[0];
    if (tag === '$datetime') return new Date(raw as string);
    if (tag === '$float' && raw === 'nan') return NaN;
    if (tag === '$bigint') return BigInt(raw as string);
    // A Python Decimal reaches a Node tool as a JS number; they must key the same.
    if (tag === '$decimal') return Number(raw as string);
    throw new Error(`unknown tag ${tag}: ${String(raw)} in a shared vector`);
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of entries) out[k] = native(v);
  return Object.setPrototypeOf(out, Object.prototype);
}

/** The Unkeyable message deriveKey gives for these arguments. */
function reason(args: Record<string, unknown>): string {
  try {
    deriveKey('a1', 't', args);
  } catch (err) {
    expect(err).toBeInstanceOf(Unkeyable);
    return (err as Error).message;
  }
  throw new Error('expected Unkeyable');
}

let warn: jest.SpyInstance;
beforeEach(() => {
  // deriveKey warns once per tool and field about a keyFields name the call lacks
  _resetMissingFieldWarningsForTests();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('vector file', () => {
  it('has the expected shape', () => {
    expect(VECTORS.version).toBe(1);
    const names = VECTORS.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of VECTORS.cases) expect('canonical' in c).toBe(!c.unkeyable);
    for (const c of SHARED) if (c.canonical) expect(JSON.parse(c.canonical).v).toBe(1);
    expect(SHARED.length).toBeGreaterThan(15);
  });

  it('matches the pinned sha256', () => {
    expect(fileSha(VECTOR_FILE)).toBe(VECTOR_SHA256);
  });

  const pythonCopy = PYTHON_VECTOR_FILE ? it : it.skip;
  pythonCopy('is identical to the Python copy (sibling checkout only)', () => {
    expect(fileSha(VECTOR_FILE)).toBe(fileSha(PYTHON_VECTOR_FILE!));
  });
});

describe('shared vectors', () => {
  test.each(SHARED.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    let args = native(c.args) as Record<string, unknown>;
    if (c.key_types) args = coerceKeyTypes(args, c.key_types);
    const extra = c.extra === undefined ? undefined : native(c.extra);
    const derive = () => deriveKey(c.agent ?? undefined, c.tool, args, c.key_fields, extra);
    if (c.unkeyable) {
      expect(derive).toThrow(Unkeyable);
    } else {
      expect(derive()).toBe(sha(c.canonical!));
    }
  });
});

/** A getter that returns `first` on the first read and a value after: encoding must use the first. */
function flaky(first: null | undefined): { v: unknown } {
  let n = 0;
  return { get v() { n += 1; return n === 1 ? first : 'late'; } };
}

describe('canonicalJson', () => {
  const bare = Object.assign(Object.create(null), { b: 2, a: 1 });
  // Values the shared vectors cannot carry (bigint, -0, undefined, holes) or do not pin.
  test.each([
    ['null', null, 'null'],
    ['true', true, 'true'],
    ['-0', -0, '0'],
    ['a bigint, losslessly', 12345678901234567890n, '12345678901234567890'],
    ['a bigint past 2**53', { n: 9007199254740993n }, '{"n":9007199254740993}'],
    ['a bigint of 31 digits', { n: 10n ** 30n }, '{"n":1000000000000000000000000000000}'],
    ['the largest safe integer', 9007199254740991, '9007199254740991'],
    // An unsafe integer keys as the double it holds, like a Python float (pass big ids as strings).
    ['an unsafe integer literal, as the double it rounded to', { n: 9007199254740993 }, '{"n":9007199254740992}'],
    ['2**60, by the exact digits of the double', 2 ** 60, '1152921504606846976'],
    ['-1e22, in plain digits', -1e22, '-10000000000000000000000'],
    ['0.0001', 0.0001, '0.0001'],
    // JS writes 1e-7 where Python writes 1e-07: both spell small numbers out.
    ['-2.5e-10, in plain digits', -2.5e-10, '-0.00000000025'],
    ['the smallest double', 5e-324, '0.' + '0'.repeat(323) + '5'],
    ['-2.5', -2.5, '-2.5'],
    ['a Date, to the millisecond', new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678)), '"2026-01-02T03:04:05.678Z"'],
    ['the first UTC Date Python accepts', new Date('0001-01-01T00:00:00.000Z'), '"0001-01-01T00:00:00.000Z"'],
    ['the last UTC Date Python accepts', new Date('9999-12-31T23:59:59.999Z'), '"9999-12-31T23:59:59.999Z"'],
    ['undefined in an object, dropped like JSON', { a: undefined, b: 1 }, '{"b":1}'],
    ['undefined in an array, as null', [undefined, 1], '[null,1]'],
    // eslint-disable-next-line no-sparse-arrays
    ['an array hole, as null', [, 1], '[null,1]'],
    ['a null-prototype object', bare, '{"a":1,"b":2}'],
    ['an own __proto__ key', JSON.parse('{"__proto__":1}'), '{"__proto__":1}'],
    ['a getter that is null on the first read, read once', flaky(null), '{"v":null}'],
    ['a getter that is undefined on the first read, read once', flaky(undefined), '{}'],
  ])('encodes %s', (_label, value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  const loop: Record<string, unknown> = {};
  loop.self = loop;
  test.each([
    ['Infinity', Infinity], ['-Infinity', -Infinity], ['NaN', NaN], ['an invalid Date', new Date('nope')],
    ['a lone high surrogate', '\uD800'], ['a lone low surrogate', 'a\uDC00b'], ['a lone surrogate key', { '\uD800': 1 }],
    ['a Map', new Map()], ['a Set', new Set()], ['a Buffer', Buffer.from('x')], ['a function', () => 1],
    ['a symbol', Symbol('s')], ['a class instance', new (class Client {})()], ['a symbol key', { [Symbol('k')]: 1 }],
    ['a typed array', new Uint8Array(1)], ['a cycle, through the depth limit', loop],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(Unkeyable);
  });
});

describe('deriveKey', () => {
  const symbolKey = Symbol('s');
  const hidden = { a: 1 };
  Object.defineProperty(hidden, Symbol('h'), { value: 1, enumerable: false });
  const inherited = () => Object.assign(Object.create({ inherited: 1 }), { a: 1 });

  // [label, args, keyFields, keys like: [args, keyFields] or the exact key]
  test.each<[string, Record<string, unknown>, string[] | undefined, [Record<string, unknown>, string[]?] | string]>([
    ['top-level undefined, like a dropped null', { a: 1, b: null, c: undefined }, undefined, [{ a: 1 }]],
    ['an own __proto__ key as a plain key', JSON.parse('{"__proto__":1}'), undefined, sha('{"agent":"a1","args":{"__proto__":1},"tool":"t","v":1}')],
    ['a keyFields name by its raw spelling, before NFC', { 'é': 1, other: 2 }, ['é'], [{ 'é': 1 }]],
    ['a composed keyFields name the decomposed arguments lack: nothing selected', { 'é': 1, other: 2 }, ['é'], [{}]],
    ['a non-enumerable symbol key, ignored', hidden, undefined, [{ a: 1 }]],
    ['a symbol key that keyFields leaves out', { [symbolKey]: 'x', a: 1 }, ['a'], [{ a: 1 }]],
    ['an optional inherited field, never selected', inherited(), ['a', 'inherited?'], [{ a: 1 }]],
    ['a required inherited field, never selected', inherited(), ['a', 'inherited'], [{ a: 1 }]],
    ['only an inherited field: the empty selection', inherited(), ['inherited'], [{}]],
    ['a required field the call lacks, left out', { to: 'a', cc: 'b' }, ['to', 'too'], [{ to: 'a', cc: 'b' }, ['to']]],
    ['a key field present as undefined: the empty selection', { to: 'a', cc: undefined }, ['cc'], [{}]],
    ['a getter, read once', flaky(null), undefined, [{}]],
    ['an object literal from another realm', vm.runInNewContext('({ order_id: "o1", items: [{ sku: "a" }] })'), undefined, [{ order_id: 'o1', items: [{ sku: 'a' }] }]],
  ])('keys %s', (_label, args, keyFields, like) => {
    const expected = typeof like === 'string' ? like : deriveKey('a1', 't', like[0], like[1]);
    expect(deriveKey('a1', 't', args, keyFields)).toBe(expected);
  });

  test.each([
    ['a Map', { client: new Map() }, 'client is Map'],
    ['a nested Buffer by its path', { items: [1, { c: Buffer.from('x') }] }, 'items[1].c is Buffer'],
    ['a class instance by its class', { c: new (class Client {})() }, 'c is Client'],
    ['a class instance from another realm', { c: vm.runInNewContext('new (class Client {})()') }, 'c is Client'],
    ['a lone surrogate', { s: 'a\uD800' }, 's has a lone surrogate'],
    ['a key with a lone surrogate', { m: { '\uD800': 1 } }, 'm has a key with a lone surrogate'],
    ['two keys equal after NFC', { m: { 'é': 1, 'é': 2 } }, 'm has two keys that are equal after NFC normalization'],
    ['NaN', { x: NaN }, 'x is NaN'],
    ['a top-level symbol key, not dropped', { [Symbol('s')]: 'x', a: 1 }, 'value has a symbol key'],
    // Python datetimes cover UTC years 1-9999 only.
    ['a Date after year 9999', { at: new Date('+010000-01-01T00:00:00.000Z') }, 'at is a Date outside the UTC range'],
    ['a Date in year 0', { at: new Date('0000-12-31T23:59:59.999Z') }, 'at is a Date outside the UTC range'],
    ['a Date before year 0', { at: new Date('-000001-06-01T00:00:00.000Z') }, 'at is a Date outside the UTC range'],
    ['local year 1 at +05:00, which is UTC year 0', { at: new Date('0001-01-01T00:00:00.000+05:00') }, 'at is a Date outside the UTC range'],
  ])('names %s in the Unkeyable reason', (_label, args, expected) => {
    expect(reason(args as Record<string, unknown>)).toBe(expected);
  });

  it('warns once per tool and field about a keyFields name the call lacks, never for an optional one', () => {
    deriveKey('a1', 't', { to: 'a', cc: 'b' }, ['to', 'too']);
    deriveKey('a1', 't', { to: 'a' }, ['to', 'too']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("keyFields names 'too'");
    expect(deriveKey('a1', 't', { to: 'a' }, ['to', 'cc?'])).toBe(deriveKey('a1', 't', { to: 'a' }, ['to']));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('idempotencyKey', () => {
  it('throws outside an idempotent tool', () => {
    expect(() => idempotencyKey()).toThrow('idempotencyKey() called outside an idempotent tool');
  });

  it('nests, survives await and returns the callback value', async () => {
    expect(bindKey('k', () => 42)).toBe(42);
    await bindKey('outer', async () => {
      expect(idempotencyKey()).toBe('outer');
      await new Promise((resolve) => setTimeout(resolve, 1));
      await bindKey('inner', async () => {
        await Promise.resolve();
        expect(idempotencyKey()).toBe('inner');
      });
      expect(idempotencyKey()).toBe('outer');
      expect(() => bindKey('boom', () => { throw new Error('x'); })).toThrow('x');
      expect(idempotencyKey()).toBe('outer');
    });
    expect(() => idempotencyKey()).toThrow(/outside/);
  });

  it('rethrows a bound Unkeyable every time', () => {
    const bad = new Unkeyable('client is Map');
    bindKey(bad, () => {
      for (let i = 0; i < 3; i++) {
        let caught: unknown;
        try {
          idempotencyKey();
        } catch (err) {
          caught = err;
        }
        expect(caught).toBe(bad);
      }
    });
  });

  it('is exported from the package root', () => {
    expect(sdk.idempotencyKey).toBe(idempotencyKey);
    expect(sdk.Unkeyable).toBe(Unkeyable);
  });
});

describe('safe JSON for span attributes and check input', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { safeStringify, jsonSafe } = require('../utils/json-safe');

  it('keeps plain JSON byte-identical', () => {
    const shared = { x: 1 };
    const v = [{ a: 1, b: [shared, shared], d: new Date(0), f: () => 1, u: undefined }, 'é', null];
    expect(safeStringify(v)).toBe(JSON.stringify(v));
    expect(jsonSafe(v)).toBe(v);
  });

  it('encodes bigint and circular values instead of throwing', () => {
    const loop: Record<string, unknown> = { n: 5n };
    loop.self = loop;
    expect(safeStringify([loop])).toBe('[{"n":"5","self":"[Circular]"}]');
    expect(jsonSafe(loop)).toEqual({ n: '5', self: '[Circular]' });
  });
});

// A quadratic regression in the two linear-time tests below trips the test timeout, so they
// assert no wall-clock bound of their own.
describe('keyTypes on long values', () => {
  it('trims and normalizes in linear time, with the same results', () => {
    const inner = ' '.repeat(80_000);
    const zeros = '0'.repeat(80_000);
    const out = coerceKeyTypes(
      { a: `10${inner}x`, b: `1.${zeros}1`, c: `${inner}7.50${inner}`, d: `true${inner}x`, e: `${inner}TRUE${inner}` },
      { a: 'number', b: 'number', c: 'number', d: 'boolean', e: 'boolean' },
    );
    expect(canonicalJson(out)).toBe(
      `{"a":"10${inner}x","b":1.${zeros}1,"c":7.5,"d":"true${inner}x","e":true}`,
    );
    expect(canonicalJson(coerceKeyTypes({ n: ` \t007.5000\v\f\r\n` }, { n: 'number' }))).toBe('{"n":7.5}');
    expect(canonicalJson(coerceKeyTypes({ n: ' 7' }, { n: 'number' }))).toBe('{"n":" 7"}');
  });
});

describe('isUnconfirmed', () => {
  const coded = (props: Record<string, unknown>) => Object.assign(new Error('x'), props);
  const refused = () => coded({ code: 'ECONNREFUSED', syscall: 'connect' });
  const definite = (cause?: unknown) => new sdk.DefiniteFailure('declined', cause === undefined ? undefined : { cause });
  const yes = (match: (e: unknown) => boolean) => match;

  // [label, error, whether the key is held]. The rows mirror the Python SDK's table.
  const IS_UNCONFIRMED: Array<[string, unknown, boolean]> = [
    // held: the tool did not say the failure is definite. An error describes only the last request:
    // a client that retried by itself or followed a redirect may have done the work before it.
    ["the tool's own error", new Error('card declined'), true],
    ['a refused connection', refused(), true],
    ['a refused fetch', Object.assign(new TypeError('fetch failed'), { cause: refused() }), true],
    ['a 429', coded({ status: 429 }), true],
    ['a 400', coded({ status: 400 }), true],
    ['gRPC INVALID_ARGUMENT', coded({ code: 3, details: 'bad', metadata: {} }), true],
    ['a timeout', coded({ name: 'TimeoutError' }), true],
    ['a thrown string', 'boom', true],
    ['null', null, true],
    // the author's say
    ['DefiniteFailure', definite(), false],
    ['DefiniteFailure over a timeout', definite(coded({ name: 'TimeoutError' })), false],
    ['a DefiniteFailure from another copy of the SDK', Object.assign(new Error('x'), { [Symbol.for('traccia.definiteFailure')]: true }), false],
    // a group is judged as itself: members can leave out work that was cancelled or still running
    ['a group of DefiniteFailures', coded({ name: 'AggregateError', errors: [definite(), definite()] }), true],
  ];
  test.each(IS_UNCONFIRMED.map(([label, error, expected]) => [label, expected, error] as const))('%s -> %s', (_label, expected, error) => {
    expect(isUnconfirmed(error)).toBe(expected);
  });

  class Declined extends Error {}
  class MaybeSent extends Error {}

  it('releases only what releaseOn returns true for, and unconfirmedOn wins anywhere in the chain', () => {
    const declined = yes((e) => e instanceof Declined);
    expect(isUnconfirmed(new Declined('x'), undefined, declined)).toBe(false);
    expect(isUnconfirmed(new MaybeSent('x'), undefined, declined)).toBe(true);
    // only true: a promise (an async hook) or another truthy value is not a yes
    expect(isUnconfirmed(new Declined('x'), undefined, (() => Promise.resolve(true)) as unknown as (e: unknown) => boolean)).toBe(true);
    expect(isUnconfirmed(new Declined('x'), undefined, (() => 1) as unknown as (e: unknown) => boolean)).toBe(true);
    const maybeSent = yes((e) => e instanceof MaybeSent);
    expect(isUnconfirmed(new Declined('x'), yes((e) => e instanceof Declined), declined)).toBe(true);
    expect(isUnconfirmed(definite(new MaybeSent('sent')), maybeSent)).toBe(true);
    expect(isUnconfirmed(definite(new MaybeSent('sent')))).toBe(false);
    const group = coded({ name: 'AggregateError', errors: [new Declined('a'), new MaybeSent('b')] });
    const isGroup = yes((e) => e === group);
    expect(isUnconfirmed(group, undefined, isGroup)).toBe(false); // the author's say on the group
    expect(isUnconfirmed(group, maybeSent, isGroup)).toBe(true);
    // a promise from unconfirmedOn holds, the safe side
    expect(isUnconfirmed(definite(), (() => Promise.resolve(false)) as unknown as (e: unknown) => boolean)).toBe(true);
  });

  it('bounds the unconfirmedOn search and holds what it could not read', () => {
    const maybeSent = yes((e) => e instanceof MaybeSent);
    const chain = (n: number) => {
      let below: unknown = new Error('bottom');
      for (let i = 0; i < n; i++) below = Object.assign(new Error('x'), { cause: below });
      return definite(below);
    };
    expect(isUnconfirmed(chain(10), maybeSent)).toBe(false);
    expect(isUnconfirmed(chain(1100), maybeSent)).toBe(true);
    const looped = definite() as Error & { cause?: unknown };
    looped.cause = Object.assign(new Error('b'), { cause: looped });
    expect(isUnconfirmed(looped, maybeSent)).toBe(false); // a cycle ends
    const errors = { *[Symbol.iterator]() { yield new Error('a'); throw new Error('broken iterator'); } };
    expect(isUnconfirmed(definite(coded({ name: 'AggregateError', errors })), maybeSent)).toBe(true);
    const hostile = definite();
    Object.defineProperty(hostile, 'cause', { get() { throw new Error('lazy'); } });
    expect(isUnconfirmed(hostile, maybeSent)).toBe(false); // a throwing getter reads as nothing
  });

  it('rejects an async releaseOn when the tool is defined', () => {
    expect(() => sdk.observe({ name: 't', asType: 'tool', idempotent: true, releaseOn: (async () => true) as unknown as (e: unknown) => boolean })(
      async () => 1,
    )).toThrow(/not a promise/);
  });
});
