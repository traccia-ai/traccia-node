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
 * - Finalization (span attributes, governance settlement, metrics) runs in the async context
 *   of the `create()` call, so it belongs to the agent and span that made the call, whichever
 *   context consumes the result.
 * - Settlement charges the Spend Cap what the call cost: its priced token usage, an estimate
 *   when the response or stream was read but carried no usage, or the full reservation when
 *   nothing of the response was read. Only a call that failed before any output releases its
 *   reservation. The settle request runs in the background; stopTracing() waits for it.
 */

import { AsyncResource } from 'async_hooks';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { getTracer } from '../auto';
import { getAgentId, getAgentName, getEnv } from '../config/runtime-config';
import { runWithSpanAsync } from '../context/context';
import {
  enforceLlmCall,
  estimateTokens,
  finishLlmCall,
  reservedUsd,
  SettleOptions,
  trackPendingSettle,
} from '../governance/pep';
import { getMetricsRecorder } from '../metrics/recorder';
import { computeCost } from '../processor/cost-processor';
import { SpanStatus, ISpan } from '../types';

let _patched = false;
let _esmPatching: Promise<boolean> | undefined;

const VENDOR = 'groq';
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
  controller?: {
    signal?: {
      aborted?: boolean;
      addEventListener?: (
        type: 'abort',
        listener: () => void,
        options?: { once?: boolean }
      ) => void;
      removeEventListener?: (type: 'abort', listener: () => void) => void;
    };
  };
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
    // Prompt tokens are the uncached input, as the cost processor and the platform price them;
    // cached input is priced at its own rate.
    const cached = cachedTokens(usage, u.prompt_tokens);
    const uncached = typeof u.prompt_tokens === 'number' ? u.prompt_tokens - cached : u.prompt_tokens;
    span.setAttribute('llm.usage.prompt_tokens', uncached);
    span.setAttribute('llm.usage.input_tokens', uncached);
    if (cached) {
      span.setAttribute('llm.usage.cache_read_tokens', cached);
    }
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
  if (typeof respModel === 'string' && respModel) {
    // The model Groq ran and billed, which settlement prices too, so the span's cost agrees
    // with the settled cost. A different requested name is kept alongside.
    const requested = span.attributes['llm.model'];
    if (requested && requested !== respModel) {
      span.setAttribute('llm.request.model', requested);
    }
    span.setAttribute('llm.model', respModel);
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

/**
 * Prompt and completion token counts from a Groq `usage` object, if it has both.
 */
/**
 * Prompt, completion and cached prompt token counts from a Groq usage object, if it has prompt
 * and completion counts. Cached tokens (`prompt_tokens_details.cached_tokens`, billed at the
 * cached input rate) are part of the prompt count; 0 when Groq reports none.
 */
function readTokens(usage: unknown): { input: number; output: number; cached: number } | undefined {
  const input = safeGet(usage, 'prompt_tokens');
  const output = safeGet(usage, 'completion_tokens');
  if (typeof input !== 'number' || typeof output !== 'number') {
    return undefined;
  }
  return { input, output, cached: cachedTokens(usage, input) };
}

/** Cached prompt tokens in a Groq usage object, at most the prompt count; 0 when none. */
function cachedTokens(usage: unknown, prompt: unknown): number {
  const cached = safeGet(usage, 'prompt_tokens_details.cached_tokens');
  if (typeof cached !== 'number' || !Number.isFinite(cached) || cached <= 0) {
    return 0;
  }
  return typeof prompt === 'number' ? Math.min(cached, Math.max(prompt, 0)) : 0;
}

/**
 * Characters of output in a message or delta: its content plus any tool call arguments.
 */
function outputChars(message: unknown): number {
  const content = safeGet(message, 'content');
  let chars = typeof content === 'string' ? content.length : 0;
  const toolCalls = safeGet(message, 'tool_calls');
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      const args = safeGet(call, 'function.arguments');
      chars += typeof args === 'string' ? args.length : 0;
    }
  }
  return chars;
}

/**
 * USD cost of the tokens at Groq's price in the SDK's pricing table, or undefined when the
 * table has no Groq entry for the model (the server then prices the tokens). Only Groq's own
 * entries are used (see STRICT_VENDORS). `cached` tokens are part of `input`.
 */
function priceTokens(
  model: string | undefined,
  input: number,
  output: number,
  cached = 0
): number | undefined {
  if (!model) {
    return undefined;
  }
  try {
    return computeCost(model, input - cached, output, VENDOR, cached);
  } catch {
    return undefined;
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

// A stream or promise dropped before its data is read still ends its span.
const abandoned = FinalizationRegistryCtor
  ? new FinalizationRegistryCtor((state) => {
      void state.finalize({ kind: 'success' });
    })
  : undefined;

/**
 * Span and governance state for one create() call. Holds no reference to the response or
 * stream, so it can be the held value for abandoned.
 */
class CallState {
  /** Async context of the create() call: run identity, PEP flag, and this span as current. */
  public scope: AsyncResource | undefined;
  public decision: Record<string, unknown> | undefined;
  /** The model sent to Groq, after any reshape by the policy check. */
  public requestModel: string | undefined;
  /** next()/return() calls in progress. groq-sdk's own aborts happen inside them. */
  public iterating = 0;
  private done = false;
  private detachAbort: (() => void) | undefined;
  private readonly parts: string[] = [];
  /** Output characters streamed so far (content and tool call arguments). */
  private streamedChars = 0;
  /** Stream chunks read so far. */
  private chunks = 0;
  private respModel: unknown;
  private usage: unknown;
  private finishReason: unknown;
  private readonly startedAt = Date.now();

  /**
   * @param promptTokens - Estimated prompt size, used when Groq reports no usage
   */
  public constructor(
    private readonly span: ISpan,
    private readonly promptTokens: number | undefined
  ) {}

  /**
   * Collect content, finish reason and usage from one ChatCompletionChunk.
   */
  public onChunk(chunk: unknown): void {
    this.chunks++;
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
      this.streamedChars += outputChars(safeGet(choice, 'delta'));
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
    abandoned?.register(stream as object, this, this);
    const signal = stream.controller?.signal;
    if (signal) {
      // An abort while no read is in progress ends the span now. groq-sdk also aborts the
      // request when a loop stops early or fails, but only inside next()/return(), which
      // record those outcomes themselves.
      const onAbort = (): void => {
        if (state.iterating === 0) {
          void state.finalize({ kind: 'aborted' });
        }
      };
      if (signal.aborted) {
        onAbort();
      } else if (signal.addEventListener) {
        signal.addEventListener('abort', onAbort, { once: true });
        this.detachAbort = (): void => signal.removeEventListener?.('abort', onAbort);
      }
    }
  }

  /**
   * Record the outcome, settle the governance reservation, record metrics, and end the span.
   * Runs in the create() call's async context; only the first call does anything. Finishes
   * synchronously (the settle continues in the background) and never rejects.
   */
  public finalize(outcome: Outcome): Promise<void> {
    if (this.done) {
      return Promise.resolve();
    }
    this.done = true;
    abandoned?.unregister(this);
    this.detachAbort?.();
    const run = (): void => {
      try {
        let usage: unknown;
        let respModel: unknown;
        let chars: number;
        // Whether any of the response reached the caller, so Groq produced output.
        let read: boolean;
        if (outcome.kind === 'success' && outcome.response !== undefined) {
          read = true;
          const response = outcome.response;
          const choice = firstChoice(response);
          const content = safeGet(choice, 'message.content');
          usage = safeGet(response, 'usage');
          respModel = safeGet(response, 'model');
          chars = outputChars(safeGet(choice, 'message'));
          recordUsage(this.span, usage);
          recordCompletion(
            this.span,
            typeof content === 'string' ? content : undefined,
            safeGet(choice, 'finish_reason'),
            respModel
          );
        } else {
          // A stream, or a call that ended before its data was read. After an abort or error
          // this keeps the text and any usage that arrived, as a stopped loop does.
          usage = this.usage;
          respModel = this.respModel;
          chars = this.streamedChars;
          read = this.chunks > 0;
          recordUsage(this.span, usage);
          recordCompletion(
            this.span,
            this.parts.join('') || undefined,
            outcome.kind === 'success' ? this.finishReason : undefined,
            respModel
          );
        }
        if (outcome.kind !== 'success') {
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
        }
        const model =
          (typeof respModel === 'string' && respModel) || this.requestModel || undefined;
        const tokens = readTokens(usage);
        const settle = this.settlement(outcome, tokens, model, chars, read);
        this.recordMetrics(outcome, tokens, model, tokens ? settle.actualUsd : undefined);
        // In the background, so a slow policy server does not delay the caller's data. It
        // starts here, in the call's context, so it settles for the agent that made the call.
        trackPendingSettle(finishLlmCall(this.decision, settle).catch(() => undefined));
      } catch {
        // Recording is best-effort; the span still ends below.
      } finally {
        this.span.end();
      }
    };
    if (this.scope) {
      this.scope.runInAsyncScope(run);
    } else {
      run();
    }
    return Promise.resolve();
  }

  /**
   * What to settle the reservation with. Groq bills the tokens it generated, also for a
   * stream that was stopped, aborted or failed partway.
   *
   * @param read - Whether any of the response reached the caller
   */
  private settlement(
    outcome: Outcome,
    tokens: { input: number; output: number; cached: number } | undefined,
    model: string | undefined,
    chars: number,
    read: boolean
  ): SettleOptions {
    if (tokens) {
      return {
        actualUsd: priceTokens(model, tokens.input, tokens.output, tokens.cached),
        model,
        vendor: VENDOR,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
      };
    }
    if (read || chars > 0) {
      // The response was read but carried no usage (or the stream stopped before it): estimate
      // the output from the text, at least one token, and the prompt from the request. The
      // server prices the estimate, and only does so when both counts are present.
      return {
        model,
        vendor: VENDOR,
        inputTokens: this.promptTokens ?? 0,
        outputTokens: Math.max(Math.ceil(chars / 4), 1),
      };
    }
    if (outcome.kind === 'success') {
      // The call completed but nothing of the response was read, so its cost is unknown:
      // charge the full reservation rather than nothing.
      return { actualUsd: reservedUsd(this.decision) };
    }
    return { release: true };
  }

  /**
   * Record token, duration, cost and exception metrics, as the Python OpenAI integration does.
   * Tokens and cost are recorded only when Groq reported usage, never from estimates.
   */
  private recordMetrics(
    outcome: Outcome,
    tokens: { input: number; output: number } | undefined,
    model: string | undefined,
    cost: number | undefined
  ): void {
    try {
      const recorder = getMetricsRecorder();
      if (!recorder) {
        return;
      }
      // The run's agent identity, so the data point is attributed to the agent that made
      // the call rather than to the service.
      const attributes: Record<string, string> = { 'gen_ai.system': VENDOR };
      if (model) {
        attributes['gen_ai.request.model'] = model;
      }
      const agentId = getAgentId();
      const agentName = getAgentName();
      const env = getEnv();
      if (agentId) {
        attributes['agent.id'] = agentId;
        attributes['agent_id'] = agentId;
      }
      if (agentName) {
        attributes['agent.name'] = agentName;
      }
      if (env) {
        attributes['environment'] = env;
      }
      if (tokens) {
        recorder.recordTokenUsage(tokens.input, tokens.output, attributes);
      }
      recorder.recordDuration((Date.now() - this.startedAt) / 1000, attributes);
      if (cost != null) {
        recorder.recordCost(cost, attributes);
      }
      if (outcome.kind === 'error') {
        recorder.recordException(attributes);
      }
    } catch {
      // Metrics are best-effort.
    }
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
      state.iterating++;
      try {
        result = await it.next(...args);
      } catch (error: unknown) {
        await state.finalize({ kind: 'error', error });
        throw error;
      } finally {
        state.iterating--;
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
      state.iterating++;
      try {
        return it.return
          ? await it.return(value)
          : ({ done: true, value } as IteratorResult<unknown>);
      } finally {
        state.iterating--;
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

  public constructor(
    public readonly state: CallState,
    private readonly streaming: boolean
  ) {}

  public parse(): Promise<unknown> {
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
        (response) => {
          if (!this.streaming) {
            void this.recordRawResponse(response);
          }
          return response;
        },
        async (error: unknown) => {
          await this.state.finalize({ kind: 'error', error });
          throw error;
        }
      );
  }

  /**
   * Record a non-streaming call from its raw `Response`, read through a clone so the caller's
   * body stays unread. A caller who reads the raw body and never awaits the data is then
   * charged the call's usage, not its full reservation. Streams are left to the caller: reading
   * a clone to the end would keep the request open after the caller cancels it.
   */
  private async recordRawResponse(response: unknown): Promise<void> {
    const raw = response as { clone?: () => { json?: () => Promise<unknown> } | null } | null;
    if (typeof raw?.clone !== 'function') {
      return;
    }
    try {
      const copy = raw.clone();
      if (typeof copy?.json !== 'function') {
        return;
      }
      await this.state.finalize({ kind: 'success', response: await copy.json() });
    } catch {
      // Unreadable: the data, if awaited, or garbage collection settles the call instead.
    }
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
    // groq-sdk sends the request whether or not the promise is awaited. If it never is (or
    // only asResponse() is used), the span ends and the call settles when this promise is
    // garbage collected. parse() unregisters it.
    abandoned?.register(this, call.state, call);
  }

  private parse(): Promise<T> {
    if (this.parsedPromise === undefined) {
      abandoned?.unregister(this.call);
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
export function wrapGroqChatCompletionsCreate<F extends (...args: never[]) => unknown>(
  createFn: F,
  instance: unknown
): F {
  const original = createFn as unknown as PatchedFn;
  if (original._agentTracePatched) {
    return createFn;
  }
  const wrapped = function wrappedCreate(this: unknown, ...args: unknown[]): unknown {
    // A shallow copy of the request: a reshape by the policy check changes the copy that is
    // sent, never the caller's own object, which they may reuse for later calls.
    const body = args[0];
    const kwargs = (
      body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {}
    ) as Record<string, unknown>;
    const callArgs = body && typeof body === 'object' ? [kwargs, ...args.slice(1)] : args;
    const messages = extractMessages(kwargs);
    const promptText = extractPromptText(messages);

    const span = getTracer('groq').startSpan(SPAN_NAME);
    const attributes: Record<string, unknown> = {
      'llm.vendor': VENDOR,
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

    const state = new CallState(span, estimateTokens(kwargs));
    const call = new GroqCall(state, kwargs.stream === true);
    const thisArg = instance || this;
    call.started = runWithSpanAsync(span, async () => {
      // Created while this span is current, inside the caller's run identity.
      state.scope = new AsyncResource('traccia.groq.chat.completions');
      state.decision = await enforceLlmCall(kwargs, { vendor: VENDOR });
      if (typeof kwargs.model === 'string') {
        state.requestModel = kwargs.model;
        span.setAttribute('llm.model', kwargs.model);
      }
      // Wrapped in an object so the APIPromise is not awaited (and parsed) here.
      return { api: original.apply(thisArg, callArgs) as GroqApiPromise };
    });
    // The caller observes failures through the returned promise.
    call.started.catch(() => undefined);
    return new TracedApiPromise(call);
  } as PatchedFn;
  wrapped._agentTracePatched = true;
  return wrapped as unknown as F;
}

type CompletionsClass = { prototype?: { create?: PatchedFn } };

/** Imports a module by URL, as a dynamic `import()` does. */
export type ImportModule = (url: string) => Promise<unknown>;

/**
 * A real dynamic `import()`. Built with Function so that neither tsc (`module: commonjs`) nor
 * the CommonJS bundle rewrites it into `require()`, which would load the CommonJS build again.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importModule = new Function('url', 'return import(url)') as ImportModule;

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
 * Wrap `create` on one build's Completions class. False if the class has no `create`.
 */
function patchCompletions(Completions: CompletionsClass | null | undefined): boolean {
  const proto = Completions?.prototype;
  if (!proto || typeof proto.create !== 'function') {
    return false;
  }
  if (!proto.create._agentTracePatched) {
    proto.create = wrapGroqChatCompletionsCreate(proto.create, null);
  }
  return true;
}

/**
 * Files of groq-sdk's ES module build of the Completions resource, from this package's
 * resolution and from the app's. groq-sdk ships each one beside its CommonJS file, as `.mjs`.
 */
function esmCompletionsPaths(): string[] {
  const resolvers: Array<() => string> = [
    (): string => require.resolve(COMPLETIONS_MODULE),
    (): string => createRequire(join(process.cwd(), 'package.json')).resolve(COMPLETIONS_MODULE),
  ];
  const paths = new Set<string>();
  for (const resolve of resolvers) {
    try {
      const esm = resolve().replace(/\.c?js$/, '.mjs');
      if (existsSync(esm)) {
        paths.add(esm);
      }
    } catch {
      // Not resolvable from here.
    }
  }
  return Array.from(paths);
}

/**
 * Patch Groq (groq-sdk) chat completions for tracing, in groq-sdk's CommonJS build: the one
 * `require('groq-sdk')` and CommonJS TypeScript output load. Also starts patchGroqEsm() for
 * apps that `import` groq-sdk; `init()` waits for it.
 *
 * Soft-fails (returns false) if groq-sdk isn't installed.
 *
 * @returns true if the CommonJS build was patched, false otherwise
 */
export function patchGroq(): boolean {
  void patchGroqEsm();
  if (_patched) {
    return true;
  }

  try {
    if (!patchCompletions(requireGroqCompletions())) {
      return false;
    }
    _patched = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Patch groq-sdk's ES module build, which `import Groq from 'groq-sdk'` loads. It has its own
 * Completions class, separate from the CommonJS build's, and loads only asynchronously. Calls
 * made before the returned promise resolves are not traced.
 *
 * Soft-fails (resolves false) if groq-sdk or its ES module build isn't installed. A failed
 * attempt is retried on the next call.
 *
 * @param load - Imports a module by file URL; defaults to dynamic `import()`
 * @returns true if an ES module build was patched, false otherwise
 */
export function patchGroqEsm(load: ImportModule = importModule): Promise<boolean> {
  if (_esmPatching === undefined) {
    const attempt = (async (): Promise<boolean> => {
      let patched = false;
      for (const path of esmCompletionsPaths()) {
        try {
          const mod = (await load(pathToFileURL(path).href)) as
            | { Completions?: CompletionsClass }
            | null
            | undefined;
          patched = patchCompletions(mod?.Completions) || patched;
        } catch {
          // This build cannot be loaded here; try the next one.
        }
      }
      return patched;
    })();
    _esmPatching = attempt.then((patched) => {
      if (!patched) {
        _esmPatching = undefined;
      }
      return patched;
    });
  }
  return _esmPatching;
}
