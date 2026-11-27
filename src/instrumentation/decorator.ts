
import { getTracer } from '../auto';
import { SpanStatus } from '../types';
import { ATTR_GUARDRAIL_TRIGGERED, ATTR_GUARDRAIL_NAME, ATTR_GUARDRAIL_CATEGORY } from '../guardrails/constants';
import { governedToolCall, IdempotencyConfig, noteRetrievalAttributes, rememberToolResult } from '../governance/pep';
import { coerceKeyTypes, KEY_TYPES, KeyType, Unkeyable, isPlainObject, unkeyableFrom } from '../governance/idempotency-key';
import { safeStringify } from '../utils/json-safe';
import { applySkipArgs, parameterNames } from './skip-args';

export interface ObserveOptions {
    name?: string;
    attributes?: Record<string, unknown>;
    type?: 'span' | 'tool' | 'llm' | 'guardrail';
    /** Alias of `type`. Matches Python `as_type=`. */
    asType?: 'span' | 'tool' | 'llm' | 'guardrail';
    as_type?: 'span' | 'tool' | 'llm' | 'guardrail';
    /**
     * Names of arguments to keep out of the `function.args` span attribute
     * (for tokens, PII and similar). Matches Python `skip_args=`.
     *
     * JavaScript cannot reliably report parameter names at runtime, so a name
     * matches in two ways:
     * - Positional: parameter names are read from the function's source. An
     *   argument whose parameter is listed is dropped from the recorded array;
     *   a listed rest parameter (`...rest`) drops everything it collects.
     *   Destructured parameters have no name and never match positionally, and
     *   minified code may have renamed parameters.
     * - Object keys: when the call has exactly one argument and it is a plain
     *   object (`tool({ query, apiKey })`), its listed top-level keys are
     *   dropped. Nested values are not inspected.
     *
     * Names that match nothing are ignored. The function itself always
     * receives its arguments unchanged.
     */
    skipArgs?: string[];
    skipResult?: boolean;
    tags?: string[];
    guardrailName?: string;
    guardrailCategory?: string;
    /**
     * Tool spans only: give each call an idempotency key, read inside the tool with
     * `idempotencyKey()`. The key is committed when the tool resolves. When it throws, the key is
     * held as unconfirmed, since the call may have happened, unless the tool says the failure is
     * definite (`DefiniteFailure`, or `releaseOn`), which releases it.
     */
    idempotent?: boolean;
    /** With `idempotent`: key only these properties of the tool's single object argument. */
    keyFields?: string[];
    /**
     * With `idempotent`: hold the key as unconfirmed when this accepts any error in the chain
     * (`cause`, group `errors`), even below a `DefiniteFailure` or an error `releaseOn` accepts.
     * Every other failure is held already, so a retry inside the window is denied as
     * `idempotency_unconfirmed` instead of running blind.
     */
    unconfirmedOn?: (error: unknown) => boolean;
    /**
     * With `idempotent`: release the key when the error the tool throws is one this returns `true`
     * for (or throw a `DefiniteFailure`): the call surely did not happen, so a retry runs. Nothing is
     * released otherwise; accept only errors raised before any request could have done the work (a
     * client that retries by itself can end on a refused connection after an attempt that did).
     */
    releaseOn?: (error: unknown) => boolean;
    /** With `idempotent`: release the key on unconfirmed errors too, for a downstream that dedupes by the key. */
    releaseUnconfirmed?: boolean;
    /**
     * With `idempotent`: `'workspace'` gives every agent in the workspace the same key for the same
     * call, so one agent repeating another's action is caught. Default `'agent'` (per agent).
     */
    idempotencyScope?: 'agent' | 'workspace';
    /**
     * With `idempotent`: called with the tool's own `this` and arguments; returns values that are
     * not arguments but tell calls apart, such as the account on `this` or the current tenant.
     * They are added to the key. Returning undefined or null adds nothing.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keyExtra?: (this: any, ...args: any[]) => unknown;
    /**
     * With `idempotent`: how long (ms, default 30000) a call denied because the same call is still
     * running waits and checks again, so it runs if that call fails. 0 throws at once.
     */
    inFlightWaitMs?: number;
    /**
     * With `idempotent`: convert these fields before keying, so a model's 123 and '123' (or
     * '10.50' and 10.5) key the same. The tool still gets the original values.
     */
    keyTypes?: Record<string, KeyType>;
}

const DEFAULT_IN_FLIGHT_WAIT_MS = 30_000;

/**
 * Decorator/Wrapper to create spans around functions.
 *
 * Usage:
 * 1. As Method Decorator:
 *    class MyClass {
 *      @observe({ name: 'my-method' })
 *      method() { ... }
 *    }
 *
 * 2. As Function Wrapper:
 *    const protectedFunc = observe({ name: 'my-func' })(originalFunc);
 *
 * Method decorators work with both TypeScript's legacy `experimentalDecorators` and the
 * standard (TC39) decorators TypeScript 5 uses by default.
 */
export function observe(options: ObserveOptions = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function (
        target: any,
        propertyKey?: string | { kind?: unknown; name?: unknown },
        descriptor?: PropertyDescriptor
    ): any {
        // Case 0: standard (TC39) method decorator, called as (method, context). It must be
        // wrapped: returning the method as is would skip governance silently.
        if (typeof target === 'function' && propertyKey !== null && typeof propertyKey === 'object') {
            if (propertyKey.kind === 'method') {
                const methodName = typeof propertyKey.name === 'string' ? propertyKey.name : '';
                return createWrapper(target, options, methodName || options.name || 'method');
            }
            if (options.idempotent) {
                throw new TypeError(`observe() with idempotent: true decorates methods and functions, not a ${String(propertyKey.kind)}`);
            }
            return target;
        }

        // Case 1: Method Decorator
        if (descriptor && typeof descriptor.value === 'function') {
            const originalMethod = descriptor.value;
            descriptor.value = createWrapper(
                originalMethod,
                options,
                (typeof propertyKey === 'string' ? propertyKey : '') || options.name || 'method'
            );
            return descriptor;
        }

        // Case 2: Function Wrapper (target is the function itself)
        if (typeof target === 'function' && !propertyKey && !descriptor) {
            return createWrapper(target, options, options.name || target.name || 'function');
        }

        // Fallback/Error. An idempotent tool must never run unguarded because its shape was
        // not recognised.
        if (options.idempotent) {
            throw new TypeError('observe() with idempotent: true could not wrap this target');
        }
        return target;
    };
}

function spanTypeOf(options: ObserveOptions): string {
    return options.asType || options.as_type || options.type || 'span';
}

// Options that only mean something on an idempotent tool, in the order they are checked.
const NEEDS_IDEMPOTENT: ReadonlyArray<readonly [string, (options: ObserveOptions) => boolean]> = [
    ['keyFields requires', (o): boolean => o.keyFields != null],
    ['unconfirmedOn, releaseOn and releaseUnconfirmed require', (o): boolean => o.unconfirmedOn != null || o.releaseOn != null || Boolean(o.releaseUnconfirmed)],
    ['keyTypes requires', (o): boolean => o.keyTypes != null],
    ['inFlightWaitMs requires', (o): boolean => o.inFlightWaitMs != null],
    ['keyExtra requires', (o): boolean => o.keyExtra != null],
    ['idempotencyScope requires', (o): boolean => o.idempotencyScope != null],
];

/**
 * Wrap-time checks of the idempotency options. Returns the settings an idempotent tool uses on
 * every call, or undefined for a tool that is not idempotent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveIdempotency(fn: any, options: ObserveOptions): IdempotencyConfig | undefined {
    // A bare string is one field name, as in the Python SDK.
    const raw = options.keyFields as string[] | string | undefined;
    const keyFields = typeof raw === 'string' ? [raw] : raw;
    // Array.from reads every index: every() alone skips the holes of a sparse array.
    if (keyFields != null && (!Array.isArray(keyFields) || !Array.from(keyFields).every((f) => typeof f === 'string'))) {
        throw new Error('keyFields must be an array of field names');
    }
    if (!options.idempotent) {
        for (const [what, isSet] of NEEDS_IDEMPOTENT) {
            if (isSet(options)) throw new Error(`${what} idempotent: true`);
        }
        return undefined;
    }
    if (options.unconfirmedOn != null && typeof options.unconfirmedOn !== 'function') {
        throw new TypeError('unconfirmedOn must be a function: (error) => boolean');
    }
    if (options.releaseOn != null && typeof options.releaseOn !== 'function') {
        throw new TypeError('releaseOn must be a function: (error) => boolean');
    }
    // A promise is not a yes: an async releaseOn would free every failed call.
    if (options.releaseOn != null && (options.releaseOn as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction') {
        throw new TypeError('releaseOn must return true or false directly, not a promise');
    }
    if (options.unconfirmedOn != null && options.releaseUnconfirmed) {
        throw new Error('pass unconfirmedOn or releaseUnconfirmed: true, not both');
    }
    if (options.keyTypes != null) {
        for (const [name, kind] of Object.entries(options.keyTypes)) {
            if (!KEY_TYPES.includes(kind)) throw new Error(`keyTypes: '${name}' must be 'string', 'number' or 'boolean'`);
        }
    }
    if (options.inFlightWaitMs != null) {
        // A string ('300' from process.env) would be added as text to the deadline.
        const wait: unknown = options.inFlightWaitMs;
        if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0) {
            throw new TypeError('inFlightWaitMs must be a finite number of milliseconds, 0 or more');
        }
    }
    if (options.keyExtra != null) {
        if (typeof options.keyExtra !== 'function') {
            throw new TypeError('keyExtra must be a function: it gets the tool arguments and returns extra key values');
        }
        // The key is needed before the call, so keyExtra cannot wait for anything.
        if ((options.keyExtra as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction') {
            throw new TypeError('keyExtra must return its values directly, not a promise: an async keyExtra cannot key the call');
        }
    }
    if (options.idempotencyScope != null && options.idempotencyScope !== 'agent' && options.idempotencyScope !== 'workspace') {
        throw new Error("idempotencyScope must be 'agent' or 'workspace'");
    }
    if (spanTypeOf(options) !== 'tool') {
        throw new Error("idempotent requires asType 'tool'");
    }
    if (keyFields != null && keyFields.length === 0) {
        throw new Error('keyFields must name at least one field');
    }
    const kind = fn?.constructor?.name;
    if (kind === 'GeneratorFunction' || kind === 'AsyncGeneratorFunction') {
        throw new TypeError('idempotent tools cannot be generators in v1');
    }
    if (!options.name) {
        // The tool name is part of the key. A function or method's own name is not stable:
        // bundlers rename functions (keys would change each build, two tools could collide), and
        // two classes can each have a refund() method.
        throw new Error("idempotent tools need a name: pass observe({ name: '...' })");
    }
    return {
        keyFields,
        keyTypes: options.keyTypes ?? undefined,
        keyExtra: options.keyExtra || undefined,
        unconfirmedOn: options.unconfirmedOn ?? undefined,
        releaseOn: options.releaseOn ?? undefined,
        releaseUnconfirmed: Boolean(options.releaseUnconfirmed),
        scope: options.idempotencyScope ?? 'agent',
        inFlightWaitMs: options.inFlightWaitMs ?? DEFAULT_IN_FLIGHT_WAIT_MS,
    };
}

// Data properties the MCP SDK's RequestHandlerExtra carries besides its AbortSignal and functions.
const MCP_EXTRA_DATA = new Set(['sessionId', 'requestId', '_meta', 'authInfo', 'requestInfo']);

/**
 * The RequestHandlerExtra the MCP TypeScript SDK passes to a tool registered without an input
 * schema: per-request plumbing, so it keys like no argument. Recognised by an AbortSignal `signal`
 * beside only functions, undefined and MCP_EXTRA_DATA; model-chosen JSON cannot carry an
 * AbortSignal or functions, so a real argument object never passes for one.
 */
function isMcpRequestExtra(value: Record<string, unknown>): boolean {
    if (typeof AbortSignal === 'undefined' || !(value.signal instanceof AbortSignal)) return false;
    return Object.keys(value).every(
        (k) => k === 'signal' || MCP_EXTRA_DATA.has(k) || value[k] === undefined || typeof value[k] === 'function',
    );
}

/**
 * The tool input inside the first argument Mastra's createTool passes to `execute`
 * (`{ context, runtimeContext, mastra, ... }`). Recognised by class instances in `runtimeContext`
 * or `mastra`, which model-chosen JSON cannot carry.
 */
function mastraInput(value: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!isPlainObject(value.context)) return undefined;
    const plumbing = [value.runtimeContext, value.mastra].some(
        (v) => v !== null && typeof v === 'object' && !isPlainObject(v) && !Array.isArray(v),
    );
    return plumbing ? value.context : undefined;
}

/**
 * What an idempotent tool's key is derived from, with key types applied: the first argument only,
 * since agent frameworks pass per-call options (Vercel AI SDK, LangChain, OpenAI Agents) after it.
 * A plain object keys as itself, none/null as `{}`, anything else as `{ args: [first] }` (unkeyable
 * with keyFields). Later arguments that matter are added with keyExtra.
 */
function keyArguments(args: unknown[], config: IdempotencyConfig): Record<string, unknown> | Unkeyable {
    try {
        const material = keyedArgument(args[0], config.keyFields);
        return material instanceof Unkeyable ? material : coerceKeyTypes(material, config.keyTypes);
    } catch (error) {
        return unkeyableFrom(error, 'keying arguments'); // e.g. a Proxy trap
    }
}

function keyedArgument(first: unknown, keyFields: string[] | undefined): Record<string, unknown> | Unkeyable {
    if (first === undefined || first === null) {
        return {};
    }
    if (isPlainObject(first)) {
        if (isMcpRequestExtra(first)) return {};
        return mastraInput(first) ?? first;
    }
    if (keyFields) {
        return new Unkeyable('keyFields needs an object as the first argument');
    }
    return { args: [first] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createWrapper(fn: any, options: ObserveOptions, defaultName: string) {
    const idempotency = resolveIdempotency(fn, options);
    // Parsed once per wrapped function, and only when skipArgs needs it.
    const params = options.skipArgs && options.skipArgs.length > 0 ? parameterNames(fn) : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function (this: any, ...args: any[]) {
        const tracer = getTracer('default');
        const name = options.name || defaultName;

        const spanType = spanTypeOf(options);
        const attributes: Record<string, unknown> = {
            ...(options.attributes || {}),
            'span.type': spanType,
        };

        if (options.tags && options.tags.length > 0) {
            attributes['span.tags'] = options.tags;
        }

        // Arguments minus those named in skipArgs; safeStringify so a BigInt or circular value cannot fail the call.
        const capturedArgs = applySkipArgs(args, options.skipArgs, params);
        attributes['function.args'] = (safeStringify(capturedArgs) ?? '').slice(0, 1000);

        if (options.type === 'guardrail') {
            if (options.guardrailName) {
                attributes[ATTR_GUARDRAIL_NAME] = options.guardrailName;
            }
            if (options.guardrailCategory) {
                attributes[ATTR_GUARDRAIL_CATEGORY] = options.guardrailCategory;
            }
        }

        return tracer.startActiveSpan(name, async (span) => {
            for (const [key, value] of Object.entries(attributes)) {
                span.setAttribute(key, value);
            }

            try {
                const toolArgs =
                    args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
                        ? (args[0] as Record<string, unknown>)
                        : { args };
                const result =
                    spanType === 'tool'
                        ? await governedToolCall(
                              name,
                              toolArgs,
                              idempotency && {
                                  config: idempotency,
                                  keyArguments: keyArguments(args, idempotency),
                                  extra: idempotency.keyExtra ? () => idempotency.keyExtra.apply(this, args) : undefined,
                              },
                              () => fn.apply(this, args),
                          )
                        : await fn.apply(this, args);
                if (spanType === 'tool') {
                    rememberToolResult(name, result, toolArgs);
                }
                noteRetrievalAttributes(span.context?.traceId, span.attributes);

                if (spanType === 'guardrail' && typeof result === 'boolean') {
                    span.setAttribute(ATTR_GUARDRAIL_TRIGGERED, result);
                }

                if (!options.skipResult) {
                    try {
                        const resStr = typeof result === 'string' ? result : JSON.stringify(result);
                        span.setAttribute('result', resStr.slice(0, 1000));
                    } catch {
                        span.setAttribute('result', String(result).slice(0, 1000));
                    }
                }

                return result;
            } catch (error) {
                if (error instanceof Error) {
                    span.recordException(error);
                    span.status = SpanStatus.ERROR;
                    if (error.message) {
                        span.statusDescription = error.message;
                    }
                }
                throw error;
            } finally {
                span.end();
            }
        });
    };
}
