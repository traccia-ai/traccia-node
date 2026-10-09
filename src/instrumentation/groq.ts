/**
 * Groq (groq-sdk) auto-instrumentation via monkey patching.
 *
 * Patches `Completions.prototype.create` (`client.chat.completions.create`) to create an
 * `llm.groq.chat.completions` span for every call, including streaming (`stream: true`).
 *
 * - The value returned by `create()` keeps groq-sdk's APIPromise surface: awaiting it,
 *   `.withResponse()` and `.asResponse()` work as before, and the body is parsed lazily.
 * - Streaming: the returned `Stream` is groq-sdk's own object. Its iterator is wrapped, so the
 *   span stays open until the stream is read to the end, stopped early, aborted, or garbage
 *   collected, and then records the full completion and token usage.
 * - Finalization (span attributes, governance settlement) runs in the async context of the
 *   `create()` call, so it belongs to the agent and span that made the call, whichever
 *   context consumes the result.
 */

import { AsyncResource } from 'async_hooks';
import { createRequire } from 'module';
import { join } from 'path';
import { getTracer } from '../auto';
import { runWithSpanAsync } from '../context/context';
import { enforceLlmCall, finishLlmCall } from '../governance/pep';
import { SpanStatus, ISpan } from '../types';

let _patched = false;

const SPAN_NAME = 'llm.groq.chat.completions';
const COMPLETIONS_MODULE = 'groq-sdk/resources/chat/completions';

type PatchedFn = ((...args: unknown[]) => unknown) & { _agentTracePatched?: boolean };

/** The parts of groq-sdk's APIPromise the wrapper relies on. */
interface GroqApiPromise extends PromiseLike<unknown> {
  asResponse?: () => Promise<unknown>;
}

/** The parts of groq-sdk's Stream the wrapper relies on. */
interface GroqStream {
  iterator?: () => AsyncIterator<unknown>;
  controller?: { signal?: { aborted?: boolean } };
}

type Outcome =
  | { kind: 'success'; response?: unknown }
  | { kind: 'error'; error: unknown }
  | { kind: 'aborted' };

/**
 * Safely get a nested property from an object.
 */
function safeGet(obj: unknown, path: string, defaultValue: unknown = undefined): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) {
      return defaultValue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return defaultValue;
    }
  }
  return current ?? defaultValue;
}

/**
 * Return choices[0] of a ChatCompletion or ChatCompletionChunk.
 */
function firstChoice(obj: unknown): unknown {
  const choices = safeGet(obj, 'choices');
  return Array.isArray(choices) && choices.length > 0 ? choices[0] : undefined;
}

/**
 * Extract messages from chat completion call arguments.
 */
function extractMessages(kwargs: Record<string, unknown>): unknown[] {
  const messages = kwargs.messages;
  if (!Array.isArray(messages)) {
    return [];
  }
  // Slim down messages to reduce payload size
  return messages.map((msg: unknown) => {
    if (typeof msg === 'object' && msg !== null) {
      const m = msg as Record<string, unknown>;
      return {
        role: m.role,
        content: typeof m.content === 'string' ? m.content.slice(0, 500) : m.content,
      };
    }
    return msg;
  });
}

/**
 * Extract prompt text from messages for display: the last user message, else the first.
 */
function extractPromptText(messages: unknown[]): string {
  if (messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role === 'user' && typeof msg.content === 'string') {
      return msg.content.slice(0, 500);
    }
  }
  const first = messages[0] as Record<string, unknown>;
  return typeof first?.content === 'string' ? first.content.slice(0, 500) : '';
}

/**
 * Set token usage attributes from a Groq `usage` object.
 */
function recordUsage(span: ISpan, usage: unknown): void {
  if (!usage || typeof usage !== 'object') {
    return;
  }
  const u = usage as Record<string, unknown>;
  span.setAttribute('llm.usage.source', 'provider_usage');
  if (u.prompt_tokens != null) {
    span.setAttribute('llm.usage.prompt_tokens', u.prompt_tokens);
    span.setAttribute('llm.usage.input_tokens', u.prompt_tokens);
    span.setAttribute('llm.usage.prompt_source', 'provider_usage');
  }
  if (u.completion_tokens != null) {
    span.setAttribute('llm.usage.completion_tokens', u.completion_tokens);
    span.setAttribute('llm.usage.output_tokens', u.completion_tokens);
    span.setAttribute('llm.usage.completion_source', 'provider_usage');
  }
  if (u.total_tokens != null) {
    span.setAttribute('llm.usage.total_tokens', u.total_tokens);
  }
}

/**
 * Set completion, finish reason and response model attributes.
 */
function recordCompletion(
  span: ISpan,
  completion: string | undefined,
  finishReason: unknown,
  respModel: unknown
): void {
  if (respModel && !span.attributes['llm.model']) {
    span.setAttribute('llm.model', String(respModel));
  }
  if (completion) {
    const content = completion.slice(0, 1000);
    span.setAttribute('llm.completion', content);
    span.setAttribute('llm.response', content);
  }
  if (finishReason) {
    span.setAttribute('llm.finish_reason', String(finishReason));
  }
}

function isGroqStream(value: unknown): value is GroqStream {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as GroqStream).iterator === 'function'
  );
}

interface FinalizationRegistryLike {
  register(target: object, heldValue: unknown, unregisterToken?: object): void;
  unregister(unregisterToken: object): void;
}

// tsconfig targets ES2020, whose lib has no FinalizationRegistry type; Node has it since 14.6.
const FinalizationRegistryCtor = (
  globalThis as {
    FinalizationRegistry?: new (cleanup: (state: CallState) => void) => FinalizationRegistryLike;
  }
).FinalizationRegistry;

// A stream dropped before it is read to the end or closed still ends its span.
const abandonedStreams = FinalizationRegistryCtor
  ? new FinalizationRegistryCtor((state) => {
      void state.finalize({ kind: 'success' });
    })
  : undefined;

/**
 * Span and governance state for one create() call. Holds no reference to the response or
 * stream, so it can be the held value for abandonedStreams.
 */
class CallState {
  /** Async context of the create() call: run identity, PEP flag, and this span as current. */
  public scope: AsyncResource | undefined;
  public decision: Record<string, unknown> | undefined;
  private done = false;
  private readonly parts: string[] = [];
  private respModel: unknown;
  private usage: unknown;
  private finishReason: unknown;

  public constructor(private readonly span: ISpan) {}

  /**
   * Collect content, finish reason and usage from one ChatCompletionChunk.
   */
  public onChunk(chunk: unknown): void {
    try {
      this.respModel = this.respModel || safeGet(chunk, 'model');
      // Groq puts usage on the last chunk under x_groq.usage; chunk.usage is set instead
      // when the caller passes stream_options: { include_usage: true }.
      const usage = safeGet(chunk, 'usage') || safeGet(chunk, 'x_groq.usage');
      if (usage) {
        this.usage = usage;
      }
      const choice = firstChoice(chunk);
      const content = safeGet(choice, 'delta.content');
      if (typeof content === 'string' && content) {
        this.parts.push(content);
      }
      const finishReason = safeGet(choice, 'finish_reason');
      if (finishReason) {
        this.finishReason = finishReason;
      }
    } catch {
      // Never let span bookkeeping break the caller's stream.
    }
  }

  /**
   * Wrap the stream's iterator so the span ends when the stream does. `Stream` iterates,
   * tees and converts to a ReadableStream through `this.iterator`, so this covers all three.
   */
  public traceStream(stream: GroqStream): void {
    if (this.done) {
      return;
    }
    const original = stream.iterator;
    if (typeof original !== 'function') {
      void this.finalize({ kind: 'success' });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const state = this;
    stream.iterator = function tracedIterator(this: unknown): AsyncIterator<unknown> {
      return traceIterator(original.call(this) as AsyncIterator<unknown>, state, stream);
    };
    abandonedStreams?.register(stream as object, this, this);
  }

  /**
   * Record the outcome, settle the governance reservation, and end the span. Runs in the
   * create() call's async context; only the first call does anything. Never rejects.
   */
  public async finalize(outcome: Outcome): Promise<void> {
    if (this.done) {
      return;
    }
    this.done = true;
    abandonedStreams?.unregister(this);
    const run = async (): Promise<void> => {
      try {
        if (outcome.kind === 'success') {
          if (outcome.response !== undefined) {
            recordUsage(this.span, safeGet(outcome.response, 'usage'));
            const choice = firstChoice(outcome.response);
            const content = safeGet(choice, 'message.content');
            recordCompletion(
              this.span,
              typeof content === 'string' ? content : undefined,
              safeGet(choice, 'finish_reason'),
              safeGet(outcome.response, 'model')
            );
          } else {
            recordUsage(this.span, this.usage);
            recordCompletion(
              this.span,
              this.parts.join('') || undefined,
              this.finishReason,
              this.respModel
            );
          }
          await finishLlmCall(this.decision).catch(() => undefined);
        } else {
          if (outcome.kind === 'error' && outcome.error instanceof Error) {
            this.span.recordException(outcome.error);
          }
          this.span.status = SpanStatus.ERROR;
          this.span.statusDescription =
            outcome.kind === 'aborted'
              ? 'aborted'
              : outcome.error instanceof Error
                ? outcome.error.message || outcome.error.name
                : String(outcome.error);
          await finishLlmCall(this.decision, { release: true }).catch(() => undefined);
        }
      } catch {
        // Recording is best-effort; the span still ends below.
      } finally {
        this.span.end();
      }
    };
    await (this.scope ? this.scope.runInAsyncScope(run) : run());
  }
}

/**
 * Wrap a stream iterator: record each chunk, and finalize when it ends, fails, or is
 * stopped early. An abort (`stream.controller.abort()`) ends groq-sdk's iteration without an
 * error, so the controller's signal is checked to report it as aborted.
 */
function traceIterator(
  it: AsyncIterator<unknown>,
  state: CallState,
  stream: GroqStream
): AsyncIterator<unknown> & AsyncIterable<unknown> {
  const aborted = (): boolean => Boolean(stream.controller?.signal?.aborted);
  return {
    async next(...args: [] | [unknown]): Promise<IteratorResult<unknown>> {
      let result: IteratorResult<unknown>;
      try {
        result = await it.next(...args);
      } catch (error: unknown) {
        await state.finalize({ kind: 'error', error });
        throw error;
      }
      if (result.done) {
        await state.finalize(aborted() ? { kind: 'aborted' } : { kind: 'success' });
      } else {
        state.onChunk(result.value);
      }
      return result;
    },
    async return(value?: unknown): Promise<IteratorResult<unknown>> {
      // Read before it.return(): groq-sdk aborts the request itself when a loop stops early,
      // which must not be mistaken for the caller aborting.
      const wasAborted = aborted();
      try {
        return it.return
          ? await it.return(value)
          : ({ done: true, value } as IteratorResult<unknown>);
      } finally {
        await state.finalize(wasAborted ? { kind: 'aborted' } : { kind: 'success' });
      }
    },
    async throw(error?: unknown): Promise<IteratorResult<unknown>> {
      await state.finalize({ kind: 'error', error });
      if (it.throw) {
        return it.throw(error);
      }
      throw error;
    },
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return this as AsyncIterator<unknown>;
    },
  };
}

/**
 * Coordinates one create() call: waits for the governance check and the request, then
 * finalizes the span from whichever of await / withResponse() / asResponse() the caller uses.
 */
class GroqCall {
  public started: Promise<{ api: GroqApiPromise }>;
  private parseRequested = false;

  public constructor(
    public readonly state: CallState,
    private readonly streaming: boolean
  ) {}

  public parse(): Promise<unknown> {
    this.parseRequested = true;
    return this.started
      .then(({ api }) => api)
      .then(
        async (data) => {
          if (this.streaming && isGroqStream(data)) {
            this.state.traceStream(data);
          } else {
            await this.state.finalize({ kind: 'success', response: data });
          }
          return data;
        },
        async (error: unknown) => {
          await this.state.finalize({ kind: 'error', error });
          throw error;
        }
      );
  }

  public asResponse(): Promise<unknown> {
    return this.started
      .then(({ api }) => {
        if (typeof api.asResponse !== 'function') {
          throw new TypeError('asResponse() is not available on this Groq client');
        }
        return api.asResponse();
      })
      .then(
        async (response) => {
          // asResponse() alone leaves the body unread, so there is nothing more to record.
          if (!this.parseRequested) {
            await this.state.finalize({ kind: 'success' });
          }
          return response;
        },
        async (error: unknown) => {
          await this.state.finalize({ kind: 'error', error });
          throw error;
        }
      );
  }
}

/**
 * What a patched `create()` returns. Like groq-sdk's APIPromise it parses lazily on
 * then/catch/finally, so `asResponse()` can still return an unread `Response`.
 */
class TracedApiPromise<T> extends Promise<T> {
  private parsedPromise: Promise<T> | undefined;

  // then() returns plain Promises; never construct this class from an inherited method.
  public static get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  public constructor(private readonly call: GroqCall) {
    super((resolve) => {
      // A no-op, as in groq-sdk's APIPromise: the result comes from parse().
      resolve(null as T);
    });
  }

  private parse(): Promise<T> {
    if (this.parsedPromise === undefined) {
      this.parsedPromise = this.call.parse() as Promise<T>;
    }
    return this.parsedPromise;
  }

  public then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    return this.parse().then(onfulfilled, onrejected);
  }

  public catch<R = never>(
    onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null
  ): Promise<T | R> {
    return this.parse().catch(onrejected);
  }

  public finally(onfinally?: (() => void) | null): Promise<T> {
    return this.parse().finally(onfinally);
  }

  /** The raw `Response`, with the body unread. */
  public asResponse(): Promise<unknown> {
    return this.call.asResponse();
  }

  /** The parsed data and the raw `Response`. */
  public async withResponse(): Promise<{ data: T; response: unknown }> {
    const [data, response] = await Promise.all([this.parse(), this.asResponse()]);
    return { data, response };
  }
}

/**
 * Wrap a Groq `chat.completions.create` call (Completions#create).
 *
 * @param createFn - The original create method
 * @param instance - The Completions instance to call it on, or null to use `this`
 * @returns The traced create method
 */
export function wrapGroqChatCompletionsCreate<T>(
  createFn: (...args: unknown[]) => T,
  instance: unknown
): (...args: unknown[]) => T {
  const existing = createFn as PatchedFn;
  if (existing._agentTracePatched) {
    return createFn;
  }
  const wrapped = function wrappedCreate(this: unknown, ...args: unknown[]): T {
    const kwargs = (args[0] || {}) as Record<string, unknown>;
    const messages = extractMessages(kwargs);
    const promptText = extractPromptText(messages);

    const span = getTracer('groq').startSpan(SPAN_NAME);
    const attributes: Record<string, unknown> = {
      'llm.vendor': 'groq',
      'span.type': 'LLM',
    };
    if (typeof kwargs.model === 'string') {
      attributes['llm.model'] = kwargs.model;
    }
    if (promptText) {
      attributes['llm.prompt'] = promptText;
    }
    if (messages.length > 0) {
      const serialized = JSON.stringify(messages).slice(0, 2000);
      attributes['llm.groq.messages'] = serialized;
      attributes['llm.messages'] = serialized;
    }
    if (kwargs.stream === true) {
      attributes['llm.streaming'] = true;
    }
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }

    const state = new CallState(span);
    const call = new GroqCall(state, kwargs.stream === true);
    const thisArg = instance || this;
    call.started = runWithSpanAsync(span, async () => {
      // Created while this span is current, inside the caller's run identity.
      state.scope = new AsyncResource('traccia.groq.chat.completions');
      state.decision = await enforceLlmCall(kwargs);
      if (typeof kwargs.model === 'string') {
        span.setAttribute('llm.model', kwargs.model);
      }
      // Wrapped in an object so the APIPromise is not awaited (and parsed) here.
      return { api: createFn.apply(thisArg, args) as GroqApiPromise };
    });
    // The caller observes failures through the returned promise.
    call.started.catch(() => undefined);
    return new TracedApiPromise(call) as unknown as T;
  } as PatchedFn;
  wrapped._agentTracePatched = true;
  return wrapped as (...args: unknown[]) => T;
}

type CompletionsClass = { prototype?: { create?: PatchedFn } };

function loadCompletions(load: (id: string) => unknown): CompletionsClass | null {
  const mod = load(COMPLETIONS_MODULE) as { Completions?: CompletionsClass } | null | undefined;
  return mod?.Completions ?? null;
}

/**
 * Load groq-sdk's Completions class, from this package's resolution or from the app's.
 */
function requireGroqCompletions(): CompletionsClass | null {
  try {
    return loadCompletions(require);
  } catch {
    try {
      return loadCompletions(createRequire(join(process.cwd(), 'package.json')));
    } catch {
      return null;
    }
  }
}

/**
 * Patch Groq (groq-sdk) chat completions for tracing.
 *
 * Soft-fails (returns false) if groq-sdk isn't installed. Patches the CommonJS build of
 * groq-sdk, which is what `require('groq-sdk')` and CommonJS TypeScript output load.
 *
 * @returns true if patched successfully, false otherwise
 */
export function patchGroq(): boolean {
  if (_patched) {
    return true;
  }

  try {
    const Completions = requireGroqCompletions();
    const proto = Completions?.prototype;
    if (!proto || typeof proto.create !== 'function') {
      return false;
    }
    if (!proto.create._agentTracePatched) {
      proto.create = wrapGroqChatCompletionsCreate(proto.create, null) as PatchedFn;
    }
    _patched = true;
    return true;
  } catch {
    return false;
  }
}
