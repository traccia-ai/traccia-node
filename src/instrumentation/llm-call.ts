/**
 * Shared call lifecycle for patched provider `create` methods (OpenAI, Anthropic).
 *
 * Handles what a plain `async` wrapper cannot:
 * - Streaming (`stream: true`): the span and governance hold stay open until the
 *   returned stream is fully consumed (including through `.tee()` branches),
 *   closed early, aborted, or errors.
 * - Authorization context: governance is settled inside the async context that
 *   authorized the call (run identity + span), even when the response or stream
 *   is consumed from a different identity scope or none at all.
 * - Provider promise helpers: the provider SDKs return an `APIPromise` and call
 *   `.withResponse()` / `._thenUnwrap()` on it internally (e.g. Anthropic
 *   `messages.stream()`, OpenAI `chat.completions.parse()`). The returned promise
 *   keeps those methods and, like `APIPromise`, only parses the body when the
 *   data is requested, so `.asResponse()` hands back an unread body.
 */

import { AsyncResource } from 'async_hooks';
import { getTracer } from '../auto';
import { runWithSpanAsync } from '../context/context';
import { SpanStatus, ISpan } from '../types';
import { enforceLlmCall, finishLlmCall } from '../governance/pep';

export interface ProviderCallHooks<S> {
    tracerName: string;
    spanName: string;
    attributes: Record<string, unknown>;
    /** Populate the span from a completed (non-streaming) response. */
    onResponse(span: ISpan, response: unknown): void;
    /** Fresh accumulator for one streamed call. */
    initStreamState(): S;
    /** Called for every streamed event/chunk. */
    onStreamEvent(span: ISpan, event: unknown, state: S): void;
    /** Called once when the stream completes successfully. */
    onStreamEnd(span: ISpan, state: S): void;
}

/** Result of `APIPromise#withResponse()`: `{ data, response, request_id? }`. */
interface RawResult {
    data: unknown;
    response?: unknown;
    [key: string]: unknown;
}

/** Promise returned by patched `create`, mirroring the provider `APIPromise` helpers. */
export interface ProviderPromise<T> extends Promise<T> {
    withResponse(): Promise<RawResult>;
    asResponse(): Promise<unknown>;
    parse(): Promise<T>;
    _thenUnwrap<U>(transform: (data: T, props: { response?: unknown }) => U): ProviderPromise<U>;
}

/** What the original provider `create` returns (an `APIPromise` for the real SDKs). */
type PendingCall = PromiseLike<unknown> & {
    withResponse?: () => Promise<RawResult>;
    asResponse?: () => Promise<unknown>;
};

/** Provider `Stream`: async iterable; the real SDKs also expose `iterator` and `controller`. */
type StreamLike = {
    [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
    iterator?: () => AsyncIterator<unknown>;
    controller?: { signal?: AbortSignal };
};

type Transform = (data: unknown, props: { response?: unknown }) => unknown;

const noop = (): void => undefined;
const identity: Transform = (data) => data;

function isStreamLike(value: unknown): value is StreamLike {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Partial<StreamLike>)[Symbol.asyncIterator] === 'function'
    );
}

function recordError(span: ISpan, error: unknown): void {
    if (error instanceof Error) {
        span.recordException(error);
        span.status = SpanStatus.ERROR;
        span.statusDescription = error.message;
    }
}

/** Non-enumerable request metadata the provider SDKs attach to parsed responses. */
const REQUEST_METADATA_KEYS = ['_request_id', '_workspace_id'];

/**
 * Copy provider request metadata onto a transformed result, as the native
 * `APIPromise#_thenUnwrap()` does (e.g. `chat.completions.parse()` returns a new
 * object that would otherwise lose `_request_id`).
 */
function carryRequestMetadata(from: unknown, to: unknown): unknown {
    if (!from || typeof from !== 'object' || !to || typeof to !== 'object' || Array.isArray(to)) {
        return to;
    }
    for (const key of REQUEST_METADATA_KEYS) {
        const descriptor = Object.getOwnPropertyDescriptor(from, key);
        if (descriptor && !Object.prototype.hasOwnProperty.call(to, key)) {
            Object.defineProperty(to, key, { value: descriptor.value as unknown, enumerable: false });
        }
    }
    return to;
}

/** Span population must never break the caller's request. */
function safely(fn: () => void): void {
    try {
        fn();
    } catch {
        /* ignore attribute extraction errors */
    }
}

/**
 * Observe every event of a provider stream and call `finish` exactly once when it
 * ends: done, break/return, error, or abort (including abort before iteration).
 *
 * The provider SDKs route direct iteration, `.tee()` and `toReadableStream()`
 * through `stream.iterator()`, so that is wrapped when present; tee branches then
 * share one observed source and `finish` runs when the source is exhausted.
 */
function observeStream(
    stream: StreamLike,
    onEvent: (event: unknown) => void,
    finish: (error?: unknown) => void
): void {
    const observe = (source: AsyncIterator<unknown>): AsyncIterator<unknown> => {
        const iterator: AsyncIterator<unknown> & { [Symbol.asyncIterator](): AsyncIterator<unknown> } = {
            async next(...nextArgs: [] | [unknown]): Promise<IteratorResult<unknown>> {
                try {
                    const result: IteratorResult<unknown> = await source.next(...nextArgs);
                    if (result.done) {
                        finish();
                    } else {
                        onEvent(result.value);
                    }
                    return result;
                } catch (error) {
                    finish(error);
                    throw error;
                }
            },
            return(value?: unknown): Promise<IteratorResult<unknown>> {
                finish();
                return source.return ? source.return(value) : Promise.resolve({ done: true, value });
            },
            throw(error?: unknown): Promise<IteratorResult<unknown>> {
                finish(error);
                return source.throw ? source.throw(error) : Promise.reject(error);
            },
            [Symbol.asyncIterator]() {
                return iterator;
            },
        };
        return iterator;
    };

    if (typeof stream.iterator === 'function') {
        const original = stream.iterator;
        stream.iterator = function observedIterator(): AsyncIterator<unknown> {
            return observe(original.call(stream) as AsyncIterator<unknown>);
        };
    } else {
        const original = stream[Symbol.asyncIterator];
        stream[Symbol.asyncIterator] = function observedIterator(): AsyncIterator<unknown> {
            return observe(original.call(stream) as AsyncIterator<unknown>);
        };
    }

    const signal = stream.controller?.signal;
    if (signal && typeof signal.addEventListener === 'function') {
        const onAbort = (): void => finish(new Error('Stream aborted before completion'));
        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener('abort', onAbort, { once: true });
        }
    }
}

/**
 * `APIPromise`-compatible promise: parsing starts only when the data is requested
 * (`then`/`await`, `withResponse()`, `parse()`), never for `asResponse()`.
 */
class LazyProviderPromise<T> extends Promise<T> implements ProviderPromise<T> {
    public static get [Symbol.species](): PromiseConstructor {
        return Promise;
    }

    private unwrapped?: Promise<RawResult>;

    public constructor(
        private readonly getRaw: () => Promise<RawResult>,
        private readonly getResponse: () => Promise<unknown>,
        private readonly transform: Transform = identity
    ) {
        super((resolve) => resolve(undefined as T));
    }

    public withResponse(): Promise<RawResult> {
        this.unwrapped ??= this.getRaw().then((r) => ({
            ...r,
            data: this.transform(r.data, { response: r.response }),
        }));
        return this.unwrapped;
    }

    public asResponse(): Promise<unknown> {
        return this.getResponse();
    }

    public parse(): Promise<T> {
        return this.withResponse().then((r) => r.data as T);
    }

    public _thenUnwrap<U>(fn: (data: T, props: { response?: unknown }) => U): ProviderPromise<U> {
        return new LazyProviderPromise<U>(this.getRaw, this.getResponse, (data, props) => {
            const source = this.transform(data, props);
            return carryRequestMetadata(source, fn(source as T, props));
        }
        );
    }

    public then<R1 = T, R2 = never>(
        onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
        onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
    ): Promise<R1 | R2> {
        return this.parse().then(onfulfilled, onrejected);
    }

    public catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R> {
        return this.parse().catch(onrejected);
    }

    public finally(onfinally?: (() => void) | null): Promise<T> {
        return this.parse().finally(onfinally);
    }
}

/**
 * Run a provider `create` call inside a traced, governance-enforced span.
 */
export function tracedProviderCall<S>(
    createFn: (...args: unknown[]) => unknown,
    thisArg: unknown,
    args: unknown[],
    hooks: ProviderCallHooks<S>
): ProviderPromise<unknown> {
    const tracer = getTracer(hooks.tracerName);
    const kwargs = (args[0] || {}) as Record<string, unknown>;
    const span = tracer.startSpan(hooks.spanName);
    for (const [key, value] of Object.entries(hooks.attributes)) {
        span.setAttribute(key, value);
    }

    let decision: Record<string, unknown> | undefined;
    // Replaced once the call is authorized: runs `fn` in that async context, so
    // settlement sees the authorizing agent/run identity and trace.
    let inAuthScope = <R>(fn: () => R): R => fn();
    let finalized: Promise<void> | undefined;
    let isFinalized = false;

    const finalize = (error?: unknown): Promise<void> => {
        if (!isFinalized) {
            isFinalized = true;
            if (error !== undefined) {
                recordError(span, error);
            }
            finalized = inAuthScope(() =>
                finishLlmCall(decision, error === undefined ? undefined : { release: true })
            )
                .catch(noop)
                .finally(() => span.end());
        }
        return finalized ?? Promise.resolve();
    };

    // The request starts eagerly (like the provider APIPromise); parsing is lazy.
    const request = runWithSpanAsync(span, async (): Promise<{ pending: PendingCall }> => {
        decision = await enforceLlmCall(kwargs, hooks.attributes['llm.vendor'] as string | undefined);
        const scope = new AsyncResource('traccia.llm_call');
        inAuthScope = (fn) => scope.runInAsyncScope(fn);
        // Wrapped in an object: returning the thenable APIPromise directly would await it and parse the body.
        return { pending: createFn.apply(thisArg, args) as PendingCall };
    });
    request.catch((error) => finalize(error));

    let parsed: Promise<RawResult> | undefined;
    let parseStarted = false;
    const getRaw = (): Promise<RawResult> => {
        parseStarted = true;
        parsed ??= request.then(async ({ pending }) => {
            try {
                const result: RawResult =
                    typeof pending?.withResponse === 'function'
                        ? await pending.withResponse()
                        : { data: await pending };

                if (kwargs.stream === true && isStreamLike(result.data)) {
                    const state = hooks.initStreamState();
                    observeStream(
                        result.data,
                        (event) => safely(() => hooks.onStreamEvent(span, event, state)),
                        (error) => {
                            if (error === undefined && !isFinalized) {
                                safely(() => hooks.onStreamEnd(span, state));
                            }
                            void finalize(error);
                        }
                    );
                    return result;
                }

                safely(() => hooks.onResponse(span, result.data));
                await finalize();
                return result;
            } catch (error) {
                await finalize(error);
                throw error;
            }
        });
        return parsed;
    };

    const getResponse = (): Promise<unknown> =>
        request.then(async ({ pending }) => {
            if (typeof pending?.asResponse !== 'function') {
                return (await getRaw()).response;
            }
            try {
                const response = await pending.asResponse();
                if (!parseStarted) {
                    // Raw response only: the body is the caller's to read, so there is
                    // no content or usage to record.
                    await finalize();
                }
                return response;
            } catch (error) {
                await finalize(error);
                throw error;
            }
        });

    return new LazyProviderPromise<unknown>(getRaw, getResponse);
}
