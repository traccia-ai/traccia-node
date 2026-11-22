import { wrapGroqChatCompletionsCreate } from '../instrumentation/groq';
import { getTracer } from '../auto';
import { drainOpenCalls, enforceLlmCall, finishLlmCall, settleOpenCalls } from '../governance/pep';
import { getAgentId, pepEnabled, runIdentity } from '../config/runtime-config';
import { getCurrentSpan } from '../context/context';
import { getMetricsRecorder } from '../metrics/recorder';
import { computeCost } from '../processor/cost-processor';
import { SpanStatus, ISpan } from '../types';

jest.mock('../auto', () => ({
  getTracer: jest.fn(),
}));

jest.mock('../governance/pep', () => {
  const actual = jest.requireActual('../governance/pep');
  return {
    enforceLlmCall: jest.fn(),
    finishLlmCall: jest.fn(),
    estimateTokens: actual.estimateTokens,
    trackPendingSettle: actual.trackPendingSettle,
    flushPendingSettles: actual.flushPendingSettles,
    reservedUsd: actual.reservedUsd,
    // Keeps the last call's state, so a test can do what garbage collection does to it.
    trackOpenCall: (call: unknown): void => {
      (globalThis as { lastGroqOpenCall?: unknown }).lastGroqOpenCall = call;
      actual.trackOpenCall(call);
    },
    untrackOpenCall: actual.untrackOpenCall,
    settleOpenCalls: actual.settleOpenCalls,
    drainOpenCalls: actual.drainOpenCalls,
  };
});

jest.mock('../processor/cost-processor', () => ({
  computeCost: jest.fn(),
}));

jest.mock('../metrics/recorder', () => ({
  getMetricsRecorder: jest.fn(),
}));

/** The state of the last call made, as the FinalizationRegistry holds it. */
function abandonedState(): unknown {
  return (globalThis as { lastGroqOpenCall?: unknown }).lastGroqOpenCall;
}

/**
 * Fake of groq-sdk's APIPromise: a Promise subclass that parses lazily on
 * then/catch/finally, with asResponse() and withResponse(). `parses` counts how
 * many times the body was parsed.
 */
class FakeAPIPromise<T> extends Promise<T> {
  public parses = 0;
  private parsed: Promise<T> | undefined;

  public static get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  public constructor(
    private readonly value: T | Error,
    public readonly response: { headers: Record<string, string> } = {
      headers: { 'x-ratelimit-remaining-requests': '99' },
    }
  ) {
    super((resolve) => resolve(null as T));
  }

  private parse(): Promise<T> {
    if (this.parsed === undefined) {
      this.parses += 1;
      this.parsed =
        this.value instanceof Error ? Promise.reject(this.value) : Promise.resolve(this.value);
    }
    return this.parsed;
  }

  public then<R1 = T, R2 = never>(
    a?: ((v: T) => R1 | PromiseLike<R1>) | null,
    b?: ((r: unknown) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    return this.parse().then(a, b);
  }

  public catch<R = never>(b?: ((r: unknown) => R | PromiseLike<R>) | null): Promise<T | R> {
    return this.parse().catch(b);
  }

  public finally(f?: (() => void) | null): Promise<T> {
    return this.parse().finally(f);
  }

  public asResponse(): Promise<unknown> {
    return this.value instanceof Error
      ? Promise.reject(this.value)
      : Promise.resolve(this.response);
  }

  public async withResponse(): Promise<{ data: T; response: unknown }> {
    const [data, response] = await Promise.all([this.parse(), this.asResponse()]);
    return { data, response };
  }
}

/**
 * Fake of groq-sdk's Stream, reproducing the behaviour the wrapper depends on:
 * `iterator` is an instance field used by Symbol.asyncIterator and tee(); stopping
 * a loop early aborts the request; an abort ends iteration without an error.
 */
class FakeStream {
  public controller = new AbortController();
  public returned = false;
  public iterator: () => AsyncIterator<unknown>;

  public constructor(chunks: unknown[], error?: Error) {
    const self = this;
    this.iterator = (): AsyncIterator<unknown> =>
      (async function* (): AsyncGenerator<unknown> {
        let done = false;
        try {
          for (const chunk of chunks) {
            if (self.controller.signal.aborted) {
              return;
            }
            yield chunk;
          }
          if (error) {
            throw error;
          }
          done = true;
        } finally {
          self.returned = !done;
          if (!done) {
            self.controller.abort();
          }
        }
      })();
  }

  public [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.iterator();
  }

  // groq-sdk's Stream.tee(), simplified to return the two halves as iterables.
  public tee(): [AsyncIterable<unknown>, AsyncIterable<unknown>] {
    const left: Promise<IteratorResult<unknown>>[] = [];
    const right: Promise<IteratorResult<unknown>>[] = [];
    const iterator = this.iterator();
    const half = (queue: Promise<IteratorResult<unknown>>[]): AsyncIterable<unknown> => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> => {
          if (queue.length === 0) {
            const result = iterator.next();
            left.push(result);
            right.push(result);
          }
          return queue.shift()!;
        },
      }),
    });
    return [half(left), half(right)];
  }
}

const MSGS = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'Capital of France?' },
];
const USAGE = { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 };
const RESPONSE = {
  model: 'llama-3.3-70b-versatile',
  usage: USAGE,
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Paris.' } }],
};

function chunk(content?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'llama-3.3-70b-versatile',
    choices: [{ delta: content === undefined ? {} : { content }, finish_reason: null }],
    ...extra,
  };
}

const CHUNKS = [
  chunk('Par'),
  chunk('is.'),
  {
    model: 'llama-3.3-70b-versatile',
    choices: [{ delta: {}, finish_reason: 'stop' }],
    x_groq: { usage: USAGE },
  },
];

const MODEL = 'llama-3.3-70b-versatile';
const COST = 0.0000123;
/** Settlement for a call whose usage Groq reported (USAGE), priced at COST. */
const PRICED = {
  actualUsd: COST,
  model: MODEL,
  vendor: 'groq',
  inputTokens: 11,
  outputTokens: 5,
};
/** 'Be brief.\nCapital of France?' is 28 characters: 7 estimated prompt tokens. */
const PROMPT_ESTIMATE = 7;

/**
 * Settlement estimated from `outputTokens` of streamed text, with no usage reported, priced
 * locally like reported usage (computeCost returns COST unless a test changes it).
 */
function estimated(outputTokens: number): Record<string, unknown> {
  return { actualUsd: COST, model: MODEL, vendor: 'groq', inputTokens: PROMPT_ESTIMATE, outputTokens };
}

async function readAll(iterable: AsyncIterable<unknown>): Promise<string> {
  let text = '';
  for await (const c of iterable) {
    // The include_usage chunk has an empty choices list.
    text += (c as { choices: { delta?: { content?: string } }[] }).choices[0]?.delta?.content ?? '';
  }
  return text;
}

describe('Groq Instrumentation', () => {
  let mockSpan: ISpan & { endCount: number };
  let mockTracer: { startSpan: jest.Mock };
  let recorder: {
    recordTokenUsage: jest.Mock;
    recordDuration: jest.Mock;
    recordCost: jest.Mock;
    recordException: jest.Mock;
  };
  const settles: Array<{
    decision: unknown;
    opts: unknown;
    agent: string | undefined;
    pep: boolean;
    span: unknown;
  }> = [];

  beforeEach(() => {
    jest.clearAllMocks();
    settles.length = 0;
    mockSpan = {
      attributes: {},
      endCount: 0,
      setAttribute: jest.fn(function (this: any, key: string, value: unknown) {
        this.attributes[key] = value;
      }),
      end: jest.fn(function (this: any) {
        this.endCount += 1;
      }),
      recordException: jest.fn(),
    } as unknown as ISpan & { endCount: number };
    mockTracer = { startSpan: jest.fn(() => mockSpan) };
    (getTracer as jest.Mock).mockReturnValue(mockTracer);
    (enforceLlmCall as jest.Mock).mockResolvedValue({ effect: 'allow', id: 'd1' });
    (computeCost as jest.Mock).mockReturnValue(COST);
    recorder = {
      recordTokenUsage: jest.fn(),
      recordDuration: jest.fn(),
      recordCost: jest.fn(),
      recordException: jest.fn(),
    };
    (getMetricsRecorder as jest.Mock).mockReturnValue(recorder);
    (finishLlmCall as jest.Mock).mockImplementation(async (decision: unknown, opts?: unknown) => {
      settles.push({
        decision,
        opts,
        agent: getAgentId(),
        pep: pepEnabled(),
        span: getCurrentSpan(),
      });
    });
  });

  /** The span records the estimate settled from: PROMPT_ESTIMATE in, `output` out. */
  function expectEstimateOnSpan(output: number): void {
    expect(mockSpan.attributes).toMatchObject({
      'llm.usage.prompt_tokens': PROMPT_ESTIMATE,
      'llm.usage.input_tokens': PROMPT_ESTIMATE,
      'llm.usage.completion_tokens': output,
      'llm.usage.output_tokens': output,
      'llm.usage.prompt_source': 'estimated',
      'llm.usage.completion_source': 'estimated',
      'llm.usage.source': 'estimated',
    });
    // The cost processor prices the span; the instrumentation sets no cost of its own.
    expect(mockSpan.attributes['llm.cost.usd']).toBeUndefined();
  }

  function wrap(result: () => unknown): { create: jest.Mock; traced: (...a: unknown[]) => any } {
    const create = jest.fn(result);
    return { create, traced: wrapGroqChatCompletionsCreate(create, null) };
  }

  describe('patchGroq', () => {
    it('patches Completions.prototype.create when groq-sdk is available', () => {
      jest.isolateModules(() => {
        const original = jest.fn();
        class Completions {
          public create = undefined;
        }
        (Completions.prototype as any).create = original;
        // Not virtual: groq-sdk is installed (a devDependency), so the mock replaces the module
        // its resolved path names, whichever file requires it.
        jest.doMock('groq-sdk/resources/chat/completions', () => ({ Completions }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('../instrumentation/groq');
        expect(fresh.patchGroq()).toBe(true);
        const patched = (Completions.prototype as any).create;
        expect(patched).not.toBe(original);
        expect(patched._agentTracePatched).toBe(true);
        expect(fresh.patchGroq()).toBe(true);
        expect((Completions.prototype as any).create).toBe(patched);
        jest.dontMock('groq-sdk/resources/chat/completions');
      });
    });

    it('soft-fails (returns false, not throw) when groq-sdk is not installed', () => {
      jest.isolateModules(() => {
        jest.doMock('groq-sdk/resources/chat/completions', () => {
          throw new Error("Cannot find module 'groq-sdk'");
        });
        // The fallback resolves from the app's directory, where groq-sdk is not installed either.
        jest.doMock('module', () => ({
          ...jest.requireActual('module'),
          createRequire: () => {
            const missing = (): never => {
              throw new Error("Cannot find module 'groq-sdk'");
            };
            return Object.assign(missing, { resolve: missing });
          },
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('../instrumentation/groq');
        expect(() => fresh.patchGroq()).not.toThrow();
        expect(fresh.patchGroq()).toBe(false);
        jest.dontMock('groq-sdk/resources/chat/completions');
        jest.dontMock('module');
      });
    });

    it('does not wrap an already wrapped create', () => {
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      expect(wrapGroqChatCompletionsCreate(traced, null)).toBe(traced);
    });
  });

  describe('patchGroqEsm', () => {
    /** A fresh copy of the module, so each test starts unpatched. */
    function freshGroq(): typeof import('../instrumentation/groq') {
      let mod: typeof import('../instrumentation/groq') | undefined;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require('../instrumentation/groq');
      });
      return mod!;
    }

    function esmBuild(): { Completions: { prototype: { create: jest.Mock } } } {
      class Completions {}
      (Completions.prototype as any).create = jest.fn();
      return { Completions } as any;
    }

    it("loads groq-sdk's ES module build beside the CommonJS file and patches it", async () => {
      const build = esmBuild();
      const original = build.Completions.prototype.create;
      const load = jest.fn(async () => build);
      const fresh = freshGroq();

      await expect(fresh.patchGroqEsm(load)).resolves.toBe(true);
      expect(load).toHaveBeenCalledTimes(1);
      const url = (load.mock.calls[0] as unknown[])[0] as string;
      expect(url.startsWith('file://')).toBe(true);
      expect(url).toMatch(/groq-sdk\/resources\/chat\/completions\.mjs$/);
      const patched = build.Completions.prototype.create as unknown as { _agentTracePatched?: boolean };
      expect(patched).not.toBe(original);
      expect(patched._agentTracePatched).toBe(true);
    });

    it('patches once, however often it is called', async () => {
      const build = esmBuild();
      const load = jest.fn(async () => build);
      const fresh = freshGroq();
      const first = fresh.patchGroqEsm(load);
      expect(fresh.patchGroqEsm(load)).toBe(first);
      await first;
      const patched = build.Completions.prototype.create;
      await expect(fresh.patchGroqEsm(load)).resolves.toBe(true);
      expect(load).toHaveBeenCalledTimes(1);
      expect(build.Completions.prototype.create).toBe(patched);
    });

    it('does not wrap a create that is already wrapped', async () => {
      const build = esmBuild();
      const wrapped = wrapGroqChatCompletionsCreate(jest.fn(), null);
      (build.Completions.prototype as any).create = wrapped;
      await expect(freshGroq().patchGroqEsm(async () => build)).resolves.toBe(true);
      expect(build.Completions.prototype.create).toBe(wrapped);
    });

    it('resolves false when the build cannot be loaded, and retries on the next call', async () => {
      const build = esmBuild();
      const load = jest
        .fn()
        .mockRejectedValueOnce(new Error('ERR_REQUIRE_ESM'))
        .mockResolvedValueOnce(build);
      const fresh = freshGroq();
      await expect(fresh.patchGroqEsm(load)).resolves.toBe(false);
      await expect(fresh.patchGroqEsm(load)).resolves.toBe(true);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('resolves false when the module has no Completions class with create', async () => {
      const fresh = freshGroq();
      await expect(fresh.patchGroqEsm(async () => ({}))).resolves.toBe(false);
      await expect(
        fresh.patchGroqEsm(async () => ({ Completions: class {} }))
      ).resolves.toBe(false);
      await expect(fresh.patchGroqEsm(async () => null)).resolves.toBe(false);
    });

    it('resolves false without loading anything when groq-sdk is not installed', async () => {
      let fresh: typeof import('../instrumentation/groq') | undefined;
      jest.isolateModules(() => {
        jest.doMock('fs', () => ({ ...jest.requireActual('fs'), existsSync: () => false }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        fresh = require('../instrumentation/groq');
      });
      const load = jest.fn();
      await expect(fresh!.patchGroqEsm(load)).resolves.toBe(false);
      expect(load).not.toHaveBeenCalled();
      jest.dontMock('fs');
    });

    it('a call through the patched ES module build is traced and governed', async () => {
      const build = esmBuild();
      build.Completions.prototype.create.mockImplementation(() => new FakeAPIPromise(RESPONSE));
      await freshGroq().patchGroqEsm(async () => build);
      const instance = Object.create(build.Completions.prototype) as { create: (b: unknown) => any };
      await instance.create({ model: MODEL, messages: MSGS });
      expect(enforceLlmCall).toHaveBeenCalledWith(expect.objectContaining({ model: MODEL }), 'groq');
      expect(settles).toEqual([expect.objectContaining({ opts: PRICED })]);
      expect(mockSpan.endCount).toBe(1);
    });
  });

  describe('non-streaming', () => {
    it('populates the span, settles once, and ends the span once', async () => {
      const { create, traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      const result = await traced({ model: 'llama-3.3-70b-versatile', messages: MSGS });

      expect(result).toBe(RESPONSE);
      expect(create).toHaveBeenCalledTimes(1);
      expect(mockTracer.startSpan).toHaveBeenCalledWith('llm.groq.chat.completions');
      const a = mockSpan.attributes;
      expect(a['llm.vendor']).toBe('groq');
      expect(a['span.type']).toBe('LLM');
      expect(a['llm.model']).toBe('llama-3.3-70b-versatile');
      expect(a['llm.prompt']).toBe('Capital of France?');
      expect(JSON.parse(a['llm.groq.messages'] as string)).toEqual(MSGS);
      expect(a['llm.messages']).toBe(a['llm.groq.messages']);
      expect(a['llm.usage.prompt_tokens']).toBe(11);
      expect(a['llm.usage.input_tokens']).toBe(11);
      expect(a['llm.usage.completion_tokens']).toBe(5);
      expect(a['llm.usage.output_tokens']).toBe(5);
      expect(a['llm.usage.total_tokens']).toBe(16);
      expect(a['llm.usage.source']).toBe('provider_usage');
      expect(a['llm.finish_reason']).toBe('stop');
      expect(a['llm.completion']).toBe('Paris.');
      expect(a['llm.response']).toBe('Paris.');
      expect(a['llm.streaming']).toBeUndefined();
      expect(settles).toHaveLength(1);
      expect(settles[0].decision).toEqual({ effect: 'allow', id: 'd1' });
      expect(settles[0].opts).toEqual(PRICED);
      expect(computeCost).toHaveBeenCalledWith(MODEL, 11, 5, 'groq', 0);
      expect(mockSpan.endCount).toBe(1);
    });

    it('sends the vendor with the policy check', async () => {
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      await traced({ model: MODEL, messages: MSGS });
      expect(enforceLlmCall).toHaveBeenCalledWith(expect.objectContaining({ model: MODEL }), 'groq');
    });

    it('prices cached prompt tokens separately and records them on the span', async () => {
      const usage = { ...USAGE, prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 } };
      const { traced } = wrap(() => new FakeAPIPromise({ ...RESPONSE, usage }));
      await traced({ model: MODEL, messages: MSGS });
      expect(computeCost).toHaveBeenCalledWith(MODEL, 200, 5, 'groq', 800);
      expect(mockSpan.attributes['llm.usage.prompt_tokens']).toBe(200);
      expect(mockSpan.attributes['llm.usage.input_tokens']).toBe(200);
      expect(mockSpan.attributes['llm.usage.cache_read_tokens']).toBe(800);
      // The settle reports every input token Groq billed.
      expect(settles[0].opts).toEqual({ ...PRICED, inputTokens: 1000 });
    });

    it('records the model Groq ran, which the settlement prices, and keeps the requested one', async () => {
      const { traced } = wrap(() => new FakeAPIPromise({ ...RESPONSE, model: 'qwen/qwen3-32b' }));
      await traced({ model: MODEL, messages: MSGS });
      expect(mockSpan.attributes['llm.model']).toBe('qwen/qwen3-32b');
      expect(mockSpan.attributes['llm.request.model']).toBe(MODEL);
      expect(computeCost).toHaveBeenCalledWith('qwen/qwen3-32b', 11, 5, 'groq', 0);
      expect(settles[0].opts).toMatchObject({ model: 'qwen/qwen3-32b' });
    });

    it('keeps the requested model when the response names the same one', async () => {
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      await traced({ model: MODEL, messages: MSGS });
      expect(mockSpan.attributes['llm.model']).toBe(MODEL);
      expect(mockSpan.attributes['llm.request.model']).toBeUndefined();
    });

    it('ignores a cached count that is not a usable number', async () => {
      const usage = { ...USAGE, prompt_tokens_details: { cached_tokens: 'many' } };
      const { traced } = wrap(() => new FakeAPIPromise({ ...RESPONSE, usage }));
      await traced({ model: MODEL, messages: MSGS });
      expect(computeCost).toHaveBeenCalledWith(MODEL, 11, 5, 'groq', 0);
      expect(mockSpan.attributes['llm.usage.cache_read_tokens']).toBeUndefined();
    });

    it('sends the tokens for the server to price when the SDK has no price', async () => {
      (computeCost as jest.Mock).mockReturnValue(undefined);
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      await traced({ model: MODEL, messages: MSGS });
      expect(settles[0].opts).toEqual({ ...PRICED, actualUsd: undefined });
      expect(recorder.recordCost).not.toHaveBeenCalled();
    });

    it('prices the reshaped model when the response names none', async () => {
      (enforceLlmCall as jest.Mock).mockImplementation(async (kwargs: Record<string, unknown>) => {
        kwargs.model = 'llama-3.1-8b-instant';
        return { effect: 'reshape' };
      });
      const { traced } = wrap(() => new FakeAPIPromise({ ...RESPONSE, model: undefined }));
      await traced({ model: MODEL, messages: MSGS });
      expect(computeCost).toHaveBeenCalledWith('llama-3.1-8b-instant', 11, 5, 'groq', 0);
      expect(settles[0].opts).toMatchObject({ model: 'llama-3.1-8b-instant' });
    });

    it('leaves an estimate for the server to price when the SDK has no price', async () => {
      (computeCost as jest.Mock).mockReturnValue(undefined);
      const { traced } = wrap(() => new FakeAPIPromise({ ...RESPONSE, usage: undefined }));
      await traced({ model: MODEL, messages: MSGS });
      expect(settles[0].opts).toEqual({ ...estimated(2), actualUsd: undefined });
    });

    it('an estimate always carries input tokens, so the server prices it', async () => {
      // Without input_tokens the server releases the reservation instead of pricing the call.
      const { traced } = wrap(() => new FakeAPIPromise({ ...RESPONSE, usage: undefined }));
      await traced({ model: MODEL, messages: [{ role: 'user', content: null }] });
      expect(settles[0].opts).toEqual({ ...estimated(2), inputTokens: 0 });
    });

    it('a read response with no usage and no output settles a one-token estimate', async () => {
      const empty = { ...RESPONSE, usage: undefined, choices: [{ finish_reason: 'stop', message: { content: '' } }] };
      const { traced } = wrap(() => new FakeAPIPromise(empty));
      await traced({ model: MODEL, messages: MSGS });
      expect(settles[0].opts).toEqual(estimated(1));
    });

    it('returns the data without waiting for the settle to reach the server', async () => {
      let finishSettle: () => void = () => undefined;
      (finishLlmCall as jest.Mock).mockImplementation(
        () => new Promise<void>((resolve) => {
          finishSettle = resolve;
        })
      );
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      await expect(traced({ model: MODEL, messages: MSGS })).resolves.toBe(RESPONSE);
      expect(finishLlmCall).toHaveBeenCalledTimes(1);
      expect(mockSpan.endCount).toBe(1);

      let flushed = false;
      const { flushPendingSettles } = jest.requireActual('../governance/pep');
      const flushing = (flushPendingSettles as () => Promise<void>)().then(() => {
        flushed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(flushed).toBe(false);
      finishSettle();
      await flushing;
      expect(flushed).toBe(true);
    });

    it('estimates the cost from the reply when the response has no usage', async () => {
      const { traced } = wrap(() => new FakeAPIPromise({ ...RESPONSE, usage: undefined }));
      await traced({ model: MODEL, messages: MSGS });
      // 'Paris.' is 6 characters: 2 output tokens, priced locally like reported usage, so a
      // pricing override applies to the estimate too.
      expect(settles[0].opts).toEqual(estimated(2));
      expect(computeCost).toHaveBeenCalledWith(MODEL, PROMPT_ESTIMATE, 2, 'groq', 0);
      expectEstimateOnSpan(2);
    });

    it('counts tool call arguments as output', async () => {
      const args = '{"city":"Paris","unit":"celsius"}'; // 33 characters: 9 tokens
      const response = {
        model: MODEL,
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ type: 'function', function: { name: 'weather', arguments: args } }],
            },
          },
        ],
      };
      const { traced } = wrap(() => new FakeAPIPromise(response));
      await traced({ model: MODEL, messages: MSGS });
      expect(settles[0].opts).toEqual(estimated(9));
      expectEstimateOnSpan(9);
    });

    it('records token, duration and cost metrics for the calling agent', async () => {
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      await runIdentity({ agentId: 'agent-a', agentName: 'Agent A' }, () =>
        traced({ model: MODEL, messages: MSGS })
      );
      const attrs = expect.objectContaining({
        'gen_ai.system': 'groq',
        'gen_ai.request.model': MODEL,
        'agent.id': 'agent-a',
        agent_id: 'agent-a',
        'agent.name': 'Agent A',
      });
      expect(recorder.recordTokenUsage).toHaveBeenCalledWith(11, 5, attrs);
      expect(recorder.recordDuration).toHaveBeenCalledWith(expect.any(Number), attrs);
      expect(recorder.recordCost).toHaveBeenCalledWith(COST, attrs);
      expect(recorder.recordException).not.toHaveBeenCalled();
    });

    it('a failing metrics recorder does not affect the call', async () => {
      recorder.recordDuration.mockImplementation(() => {
        throw new Error('meter gone');
      });
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      expect(await traced({ model: MODEL, messages: MSGS })).toBe(RESPONSE);
      expect(settles[0].opts).toEqual(PRICED);
      expect(mockSpan.endCount).toBe(1);
    });

    it('uses the response model when the request has none', async () => {
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      await traced({ messages: MSGS });
      expect(mockSpan.attributes['llm.model']).toBe('llama-3.3-70b-versatile');
    });

    it('calls create with the Completions instance as this', async () => {
      const instance = { name: 'completions' };
      let seenThis: unknown;
      const create = jest.fn(function (this: unknown) {
        seenThis = this;
        return new FakeAPIPromise(RESPONSE);
      });
      const traced = wrapGroqChatCompletionsCreate(create, null);
      await traced.call(instance, { model: 'm', messages: MSGS });
      expect(seenThis).toBe(instance);
    });

    it('returns a Promise that keeps withResponse() and asResponse()', () => {
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      const p = traced({ model: 'm', messages: MSGS });
      expect(p).toBeInstanceOf(Promise);
      expect(typeof p.withResponse).toBe('function');
      expect(typeof p.asResponse).toBe('function');
      return p;
    });

    it('withResponse() returns the data and the raw response, recorded once', async () => {
      const api = new FakeAPIPromise(RESPONSE);
      const { create, traced } = wrap(() => api);
      const { data, response } = await traced({ model: 'm', messages: MSGS }).withResponse();
      expect(data).toBe(RESPONSE);
      expect(response).toBe(api.response);
      expect(create).toHaveBeenCalledTimes(1);
      expect(api.parses).toBe(1);
      expect(mockSpan.attributes['llm.completion']).toBe('Paris.');
      expect(settles).toHaveLength(1);
      expect(mockSpan.endCount).toBe(1);
    });

    it('asResponse() returns the raw response without parsing the body', async () => {
      const api = new FakeAPIPromise(RESPONSE);
      const { traced } = wrap(() => api);
      const response = await traced({ model: 'm', messages: MSGS }).asResponse();
      expect(response).toBe(api.response);
      expect(api.parses).toBe(0);
      expect(mockSpan.attributes['llm.completion']).toBeUndefined();
      // The data may still be awaited, so the span stays open.
      expect(settles).toHaveLength(0);
      expect(mockSpan.endCount).toBe(0);
    });

    it('asResponse() alone settles the usage read from a clone of the raw response', async () => {
      const raw = {
        headers: {},
        bodyUsed: false,
        clone: jest.fn(() => ({ json: async () => RESPONSE })),
      };
      const api = new FakeAPIPromise(RESPONSE, raw as never);
      const { traced } = wrap(() => api);
      expect(await traced({ model: MODEL, messages: MSGS }).asResponse()).toBe(raw);
      await new Promise((resolve) => setImmediate(resolve));
      expect(raw.clone).toHaveBeenCalledTimes(1);
      expect(api.parses).toBe(0);
      expect(mockSpan.attributes['llm.completion']).toBe('Paris.');
      expect(settles).toEqual([expect.objectContaining({ opts: PRICED })]);
      expect(mockSpan.endCount).toBe(1);
    });

    it('asResponse() and then awaiting the data settles once', async () => {
      const raw = { headers: {}, clone: () => ({ json: async () => RESPONSE }) };
      const api = new FakeAPIPromise(RESPONSE, raw as never);
      const { traced } = wrap(() => api);
      const promise = traced({ model: MODEL, messages: MSGS });
      await promise.asResponse();
      expect(await promise).toBe(RESPONSE);
      await new Promise((resolve) => setImmediate(resolve));
      expect(settles).toHaveLength(1);
      expect(mockSpan.endCount).toBe(1);
    });

    it('asResponse() with an unreadable clone leaves the call open for the data', async () => {
      const raw = { headers: {}, clone: () => ({ json: async () => Promise.reject(new Error('not JSON')) }) };
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE, raw as never));
      await traced({ model: MODEL, messages: MSGS }).asResponse();
      await new Promise((resolve) => setImmediate(resolve));
      expect(settles).toHaveLength(0);
      expect(mockSpan.endCount).toBe(0);
    });

    it('asResponse() and then awaiting the data records the completion and usage', async () => {
      const api = new FakeAPIPromise(RESPONSE);
      const { traced } = wrap(() => api);
      const promise = traced({ model: 'm', messages: MSGS });
      expect(await promise.asResponse()).toBe(api.response);
      expect(await promise).toBe(RESPONSE);
      expect(mockSpan.attributes['llm.completion']).toBe('Paris.');
      expect(mockSpan.attributes['llm.usage.total_tokens']).toBe(16);
      expect(settles).toHaveLength(1);
      expect(mockSpan.endCount).toBe(1);
    });

    it('records a provider error, releases the reservation, and rethrows it', async () => {
      const error = new Error('rate limited');
      const { traced } = wrap(() => new FakeAPIPromise(error));
      await expect(traced({ model: 'm', messages: MSGS })).rejects.toBe(error);
      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.status).toBe(SpanStatus.ERROR);
      expect(mockSpan.statusDescription).toBe('rate limited');
      expect(settles).toEqual([
        expect.objectContaining({
          decision: { effect: 'allow', id: 'd1' },
          opts: { release: true },
        }),
      ]);
      expect(recorder.recordException).toHaveBeenCalledWith(
        expect.objectContaining({ 'gen_ai.system': 'groq', 'gen_ai.request.model': 'm' })
      );
      expect(recorder.recordTokenUsage).not.toHaveBeenCalled();
      expect(mockSpan.endCount).toBe(1);
    });

    it('a denied call never reaches the provider', async () => {
      const blocked = new Error('budget exceeded');
      (enforceLlmCall as jest.Mock).mockRejectedValue(blocked);
      const { create, traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      await expect(traced({ model: 'm', messages: MSGS })).rejects.toBe(blocked);
      expect(create).not.toHaveBeenCalled();
      expect(mockSpan.status).toBe(SpanStatus.ERROR);
      expect(settles).toEqual([
        expect.objectContaining({ decision: undefined, opts: { release: true } }),
      ]);
      expect(mockSpan.endCount).toBe(1);
    });

    it("a reshape changes the request sent, never the caller's own params", async () => {
      (enforceLlmCall as jest.Mock).mockImplementation(async (kwargs: Record<string, unknown>) => {
        kwargs.model = 'llama-3.1-8b-instant';
        kwargs.max_tokens = 100;
        return { effect: 'reshape' };
      });
      const { create, traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      const params = { model: MODEL, max_tokens: 4000, messages: MSGS };
      await traced(params, { timeout: 5 });
      expect(params).toEqual({ model: MODEL, max_tokens: 4000, messages: MSGS });
      expect(create.mock.calls[0][0]).toMatchObject({ model: 'llama-3.1-8b-instant', max_tokens: 100 });
      expect(create.mock.calls[0][0]).not.toBe(params);
      // Request options and the messages array pass through unchanged.
      expect(create.mock.calls[0][1]).toEqual({ timeout: 5 });
      expect((create.mock.calls[0][0] as { messages: unknown }).messages).toBe(MSGS);
    });

    it('a reused params object is checked as the caller wrote it every time', async () => {
      const seen: unknown[] = [];
      (enforceLlmCall as jest.Mock).mockImplementation(async (kwargs: Record<string, unknown>) => {
        seen.push(kwargs.model);
        kwargs.model = 'llama-3.1-8b-instant';
        return { effect: 'reshape' };
      });
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      const params = { model: MODEL, messages: MSGS };
      await traced(params);
      await traced(params);
      expect(seen).toEqual([MODEL, MODEL]);
      expect(params.model).toBe(MODEL);
    });

    it('a reshaped call sends the swapped model and records it', async () => {
      (enforceLlmCall as jest.Mock).mockImplementation(async (kwargs: Record<string, unknown>) => {
        kwargs.model = 'llama-3.1-8b-instant';
        kwargs.max_tokens = 100;
        return { effect: 'reshape' };
      });
      const { create, traced } = wrap(() => new FakeAPIPromise({ ...RESPONSE, model: undefined }));
      await traced({ model: 'llama-3.3-70b-versatile', messages: MSGS });
      expect(create.mock.calls[0][0]).toMatchObject({
        model: 'llama-3.1-8b-instant',
        max_tokens: 100,
      });
      expect(mockSpan.attributes['llm.model']).toBe('llama-3.1-8b-instant');
    });

    it('settles for the agent that made the call, wherever it is awaited', async () => {
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      const pending = await runIdentity({ agentId: 'agent-a', pepEnabled: true }, () => ({
        p: traced({ model: 'm', messages: MSGS }),
      }));
      await runIdentity({ agentId: 'agent-b', pepEnabled: false }, () => pending.p);
      expect(settles).toEqual([
        expect.objectContaining({ agent: 'agent-a', pep: true, span: mockSpan }),
      ]);
    });
  });

  describe('streaming', () => {
    function streamWrap(stream: FakeStream): { traced: (...a: unknown[]) => any } {
      return wrap(() => new FakeAPIPromise(stream));
    }

    it('keeps the span open until the stream is read, then records it once', async () => {
      const stream = new FakeStream(CHUNKS);
      const { traced } = streamWrap(stream);
      const result = await traced({
        model: 'llama-3.3-70b-versatile',
        messages: MSGS,
        stream: true,
      });

      expect(result).toBe(stream);
      expect(mockSpan.attributes['llm.streaming']).toBe(true);
      expect(mockSpan.endCount).toBe(0);
      expect(settles).toHaveLength(0);

      expect(await readAll(result)).toBe('Paris.');
      const a = mockSpan.attributes;
      expect(a['llm.completion']).toBe('Paris.');
      expect(a['llm.finish_reason']).toBe('stop');
      expect(a['llm.usage.prompt_tokens']).toBe(11);
      expect(a['llm.usage.completion_tokens']).toBe(5);
      expect(a['llm.usage.total_tokens']).toBe(16);
      expect(mockSpan.status).toBeUndefined();
      expect(settles).toEqual([expect.objectContaining({ opts: PRICED })]);
      expect(recorder.recordTokenUsage).toHaveBeenCalledWith(11, 5, expect.any(Object));
      expect(mockSpan.endCount).toBe(1);
    });

    it('reads usage from chunk.usage when include_usage is set', async () => {
      const chunks = [
        { ...chunk('Paris.'), choices: [{ delta: { content: 'Paris.' }, finish_reason: 'stop' }] },
        { model: 'llama-3.3-70b-versatile', choices: [], usage: USAGE },
      ];
      const { traced } = streamWrap(new FakeStream(chunks));
      await readAll(await traced({ model: 'm', messages: MSGS, stream: true }));
      expect(mockSpan.attributes['llm.usage.total_tokens']).toBe(16);
      expect(settles[0].opts).toEqual(PRICED);
    });

    it('a stream with no usage settles an estimate from the streamed text', async () => {
      const chunks = [chunk('Paris is the capital.'), chunk(undefined, {})]; // 21 chars: 6
      const { traced } = streamWrap(new FakeStream(chunks));
      await readAll(await traced({ model: MODEL, messages: MSGS, stream: true }));
      expect(mockSpan.status).toBeUndefined();
      expect(settles[0].opts).toEqual(estimated(6));
      expectEstimateOnSpan(6);
    });

    it('a stream with usage records the provider usage, not an estimate', async () => {
      const { traced } = streamWrap(new FakeStream(CHUNKS));
      await readAll(await traced({ model: MODEL, messages: MSGS, stream: true }));
      expect(mockSpan.attributes).toMatchObject({
        'llm.usage.prompt_tokens': 11,
        'llm.usage.completion_tokens': 5,
        'llm.usage.prompt_source': 'provider_usage',
        'llm.usage.completion_source': 'provider_usage',
        'llm.usage.source': 'provider_usage',
      });
    });

    it('counts streamed tool call arguments as output', async () => {
      const toolChunk = (args: string): Record<string, unknown> => ({
        model: MODEL,
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null },
        ],
      });
      const chunks = [toolChunk('{"city":'), toolChunk('"Paris"}')]; // 16 chars: 4
      const { traced } = streamWrap(new FakeStream(chunks));
      await readAll(await traced({ model: MODEL, messages: MSGS, stream: true }));
      expect(settles[0].opts).toEqual(estimated(4));
      expectEstimateOnSpan(4);
    });

    describe('reasoning streams interrupted before usage', () => {
      // 10 chunks of 4,250 reasoning characters: 42,500 characters, 10,625 tokens.
      const reasoningChunk = (): Record<string, unknown> => ({
        model: MODEL,
        choices: [{ delta: { reasoning: 'r'.repeat(4250) }, finish_reason: null }],
      });
      const reasoning = Array.from({ length: 10 }, reasoningChunk);
      const usageChunk = {
        model: MODEL,
        choices: [{ delta: {}, finish_reason: 'stop' }],
        x_groq: { usage: { prompt_tokens: 5, completion_tokens: 10700, total_tokens: 10705 } },
      };

      it('a loop stopped before usage counts the reasoning', async () => {
        const { traced } = streamWrap(new FakeStream([...reasoning, usageChunk]));
        let read = 0;
        for await (const _ of await traced({ model: MODEL, messages: MSGS, stream: true })) {
          if (++read === reasoning.length) break;
        }
        expect(settles).toEqual([expect.objectContaining({ opts: estimated(10625) })]);
        expectEstimateOnSpan(10625);
      });

      it('an abort before usage counts the reasoning', async () => {
        const stream = new FakeStream([...reasoning, usageChunk]);
        const { traced } = streamWrap(stream);
        let read = 0;
        for await (const _ of await traced({ model: MODEL, messages: MSGS, stream: true })) {
          if (++read === reasoning.length) stream.controller.abort();
        }
        expect(mockSpan.statusDescription).toBe('aborted');
        expect(settles).toEqual([expect.objectContaining({ opts: estimated(10625) })]);
        expectEstimateOnSpan(10625);
      });

      it('an error before usage counts the reasoning', async () => {
        const error = new Error('connection reset');
        const { traced } = streamWrap(new FakeStream(reasoning, error));
        await expect(readAll(await traced({ model: MODEL, messages: MSGS, stream: true }))).rejects.toBe(error);
        expect(settles).toEqual([expect.objectContaining({ opts: estimated(10625) })]);
        expectEstimateOnSpan(10625);
      });

      it('a reply with reasoning and no usage counts the reasoning', async () => {
        const response = {
          model: MODEL,
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Paris.', reasoning: 'r'.repeat(42494) } }],
        };
        const { traced } = wrap(() => new FakeAPIPromise(response));
        await traced({ model: MODEL, messages: MSGS });
        // 42,494 reasoning + 6 content characters: 42,500, so 10,625 tokens.
        expect(settles[0].opts).toEqual(estimated(10625));
        expectEstimateOnSpan(10625);
      });
    });

    it('a stream that ended without output or usage settles a one-token estimate', async () => {
      const { traced } = streamWrap(new FakeStream([chunk(undefined)]));
      await readAll(await traced({ model: MODEL, messages: MSGS, stream: true }));
      expect(settles[0].opts).toEqual(estimated(1));
      expectEstimateOnSpan(1);
    });

    it('a loop stopped on the role-only first chunk settles an estimate, not the reservation', async () => {
      (enforceLlmCall as jest.Mock).mockResolvedValue({ effect: 'allow', obligations: { reserved_usd: 0.5 } });
      const roleOnly = { model: MODEL, choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] };
      const { traced } = streamWrap(new FakeStream([roleOnly, ...CHUNKS]));
      for await (const _ of await traced({ model: MODEL, messages: MSGS, stream: true })) {
        break;
      }
      expect(settles[0].opts).toEqual(estimated(1));
    });

    it('a stream that yielded nothing at all charges the full reservation', async () => {
      (enforceLlmCall as jest.Mock).mockResolvedValue({ effect: 'allow', obligations: { reserved_usd: 0.02 } });
      const { traced } = streamWrap(new FakeStream([]));
      await readAll(await traced({ model: MODEL, messages: MSGS, stream: true }));
      expect(settles[0].opts).toEqual({ actualUsd: 0.02 });
      expect(mockSpan.attributes['llm.usage.completion_tokens']).toBeUndefined();
      expect(mockSpan.attributes['llm.usage.source']).toBeUndefined();
    });

    it('asResponse() on a stream does not read a clone of the body', async () => {
      const raw = { headers: {}, clone: jest.fn() };
      const { traced } = wrap(() => new FakeAPIPromise(new FakeStream(CHUNKS), raw as never));
      await traced({ model: MODEL, messages: MSGS, stream: true }).asResponse();
      expect(raw.clone).not.toHaveBeenCalled();
    });

    it('a loop stopped early records the partial text and settles an estimate', async () => {
      const stream = new FakeStream(CHUNKS);
      const { traced } = streamWrap(stream);
      const result = await traced({ model: 'm', messages: MSGS, stream: true });
      for await (const _ of result) {
        break;
      }
      expect(stream.returned).toBe(true);
      expect(mockSpan.attributes['llm.completion']).toBe('Par');
      expect(mockSpan.status).toBeUndefined();
      // Groq bills the tokens generated before the loop stopped: 'Par' is 1 token.
      expect(settles).toEqual([expect.objectContaining({ opts: estimated(1) })]);
      expect(mockSpan.endCount).toBe(1);
    });

    it('an aborted stream is marked aborted and settles what it streamed', async () => {
      const stream = new FakeStream(CHUNKS);
      const { traced } = streamWrap(stream);
      const result = await traced({ model: 'm', messages: MSGS, stream: true });
      let text = '';
      for await (const c of result) {
        text +=
          (c as { choices: { delta: { content?: string } }[] }).choices[0].delta.content ?? '';
        stream.controller.abort();
      }
      expect(text).toBe('Par');
      expect(mockSpan.attributes['llm.completion']).toBe('Par');
      expect(mockSpan.status).toBe(SpanStatus.ERROR);
      expect(mockSpan.statusDescription).toBe('aborted');
      expect(settles).toEqual([expect.objectContaining({ opts: estimated(1) })]);
      expect(recorder.recordException).not.toHaveBeenCalled();
      expect(mockSpan.endCount).toBe(1);
    });

    it('aborting a retained stream before any output releases the reservation', async () => {
      const stream = new FakeStream(CHUNKS);
      const { traced } = streamWrap(stream);
      const result = await traced({ model: 'm', messages: MSGS, stream: true });
      stream.controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      expect(result).toBe(stream);
      expect(mockSpan.status).toBe(SpanStatus.ERROR);
      expect(mockSpan.statusDescription).toBe('aborted');
      expect(settles).toEqual([expect.objectContaining({ opts: { release: true } })]);
      expect(mockSpan.endCount).toBe(1);
    });

    it('asResponse() and then reading the stream traces the stream', async () => {
      const stream = new FakeStream(CHUNKS);
      const { traced } = streamWrap(stream);
      const promise = traced({ model: 'm', messages: MSGS, stream: true });
      await promise.asResponse();
      expect(mockSpan.endCount).toBe(0);
      expect(await readAll(await promise)).toBe('Paris.');
      expect(mockSpan.attributes['llm.completion']).toBe('Paris.');
      expect(mockSpan.attributes['llm.usage.total_tokens']).toBe(16);
      expect(settles).toEqual([expect.objectContaining({ opts: PRICED })]);
      expect(mockSpan.endCount).toBe(1);
    });

    it('an error before any chunk releases the reservation', async () => {
      const error = new Error('connection reset');
      const { traced } = streamWrap(new FakeStream([], error));
      const result = await traced({ model: 'm', messages: MSGS, stream: true });
      await expect(readAll(result)).rejects.toBe(error);
      expect(settles).toEqual([expect.objectContaining({ opts: { release: true } })]);
    });

    it('an error mid-stream is recorded, settles what it streamed, and propagates', async () => {
      const error = new Error('connection reset');
      const { traced } = streamWrap(new FakeStream(CHUNKS.slice(0, 1), error));
      const result = await traced({ model: 'm', messages: MSGS, stream: true });
      await expect(readAll(result)).rejects.toBe(error);
      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.status).toBe(SpanStatus.ERROR);
      expect(mockSpan.statusDescription).toBe('connection reset');
      expect(mockSpan.attributes['llm.completion']).toBe('Par');
      expect(settles).toEqual([expect.objectContaining({ opts: estimated(1) })]);
      expect(recorder.recordException).toHaveBeenCalledTimes(1);
      expect(mockSpan.endCount).toBe(1);
    });

    it.each(['return', 'throw'] as const)(
      '%s() on an iterator that never read does not end the call, which is then read in full',
      async (method) => {
        const stream = new FakeStream(CHUNKS);
        const { traced } = streamWrap(stream);
        const result = await traced({ model: MODEL, messages: MSGS, stream: true });
        const unused = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        // As a ReadableStream cancelled before any read does: groq-sdk's stream is not consumed.
        await (method === 'return' ? unused.return?.() : unused.throw?.(new Error('cancel')).catch(() => undefined));
        expect(mockSpan.endCount).toBe(0);
        expect(settles).toHaveLength(0);
        expect(await readAll(result)).toBe('Paris.');
        expect(settles).toEqual([expect.objectContaining({ opts: PRICED })]);
        expect(mockSpan.status).toBeUndefined();
        expect(mockSpan.endCount).toBe(1);
      }
    );

    it('another iterator of a stream being read does not end the call', async () => {
      const stream = new FakeStream(CHUNKS);
      const { traced } = streamWrap(stream);
      const result = await traced({ model: MODEL, messages: MSGS, stream: true });
      const first = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await first.next();
      const second = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await second.return?.();
      expect(mockSpan.endCount).toBe(0);
      expect(settles).toHaveLength(0);
      while (!(await first.next()).done);
      expect(settles).toEqual([expect.objectContaining({ opts: PRICED })]);
      expect(mockSpan.attributes['llm.completion']).toBe('Paris.');
      expect(mockSpan.endCount).toBe(1);
    });

    it('tee() halves are traced through the same iterator, recorded once', async () => {
      const stream = new FakeStream(CHUNKS);
      const { traced } = streamWrap(stream);
      const result: FakeStream = await traced({ model: 'm', messages: MSGS, stream: true });
      const [left, right] = result.tee();
      expect(await readAll(left)).toBe('Paris.');
      expect(await readAll(right)).toBe('Paris.');
      expect(mockSpan.attributes['llm.completion']).toBe('Paris.');
      expect(settles).toHaveLength(1);
      expect(mockSpan.endCount).toBe(1);
    });

    it('settles for the creating agent and span when read under another agent', async () => {
      const { traced } = streamWrap(new FakeStream(CHUNKS));
      const result = await runIdentity({ agentId: 'agent-a', pepEnabled: true }, () =>
        traced({ model: 'm', messages: MSGS, stream: true })
      );
      await runIdentity({ agentId: 'agent-b', pepEnabled: false }, () => readAll(result));
      expect(settles).toEqual([
        expect.objectContaining({ agent: 'agent-a', pep: true, span: mockSpan }),
      ]);
    });

    it('settles for the creating agent when read after its context has exited', async () => {
      const { traced } = streamWrap(new FakeStream(CHUNKS));
      const result = await runIdentity({ agentId: 'agent-a', pepEnabled: true }, () =>
        traced({ model: 'm', messages: MSGS, stream: true })
      );
      await readAll(result); // no run identity is active here
      expect(settles).toEqual([expect.objectContaining({ agent: 'agent-a', pep: true })]);
    });
  });

  describe('shutdown', () => {
    const RESERVED = 0.5;

    beforeEach(async () => {
      // The registry is process-wide: settle streams earlier tests left open.
      await settleOpenCalls(1000);
      settles.length = 0;
      (enforceLlmCall as jest.Mock).mockResolvedValue({
        effect: 'allow',
        id: 'd1',
        obligations: { reserved_usd: RESERVED },
      });
    });

    it('an open stream is aborted and charged the reservation', async () => {
      const stream = new FakeStream(CHUNKS.slice(0, 2));
      const { traced } = wrap(() => new FakeAPIPromise(stream));
      const result = await traced({ model: MODEL, messages: MSGS, stream: true });
      const it = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await it.next();
      await settleOpenCalls(1000);
      expect(stream.controller.signal.aborted).toBe(true);
      // What Groq generated before the abort is unknown without usage, so the reservation.
      expect(settles).toEqual([expect.objectContaining({ opts: { actualUsd: RESERVED } })]);
      expect(mockSpan.attributes['llm.interrupted']).toBe('shutdown');
      expect(mockSpan.attributes['llm.completion']).toBe('Par');
      // The span still records the estimate of what was streamed, so no processor counts it
      // again from the completion text.
      expectEstimateOnSpan(1);
      expect(mockSpan.status).toBeUndefined();
      expect(mockSpan.endCount).toBe(1);
    });

    it.each([
      ['nothing reserved', { effect: 'allow', id: 'd1' }],
      ['governance off', undefined],
    ])('an open stream with %s ends its span but is not stopped', async (_name, decision) => {
      (enforceLlmCall as jest.Mock).mockResolvedValue(decision);
      const stream = new FakeStream(CHUNKS);
      const { traced } = wrap(() => new FakeAPIPromise(stream));
      const result = await traced({ model: MODEL, messages: MSGS, stream: true });
      const it = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await it.next();
      await settleOpenCalls(1000);
      expect(stream.controller.signal.aborted).toBe(false);
      expect(mockSpan.attributes['llm.interrupted']).toBe('shutdown');
      expect(settles).toEqual([expect.objectContaining({ opts: { actualUsd: undefined } })]);
      expect(mockSpan.endCount).toBe(1);
      // The app reads the rest; its end records nothing more.
      while (!(await it.next()).done);
      expect(stream.returned).toBe(false);
      expect(settles).toHaveLength(1);
      expect(mockSpan.endCount).toBe(1);
    });

    it('a dropped stream with nothing reserved is still stopped', async () => {
      (enforceLlmCall as jest.Mock).mockResolvedValue(undefined);
      const stream = new FakeStream(CHUNKS);
      const { traced } = wrap(() => new FakeAPIPromise(stream));
      const result = await traced({ model: MODEL, messages: MSGS, stream: true });
      await (result as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
      // What garbage collection of the stream calls.
      (abandonedState() as { collected(): void }).collected();
      expect(stream.controller.signal.aborted).toBe(true);
      expect(mockSpan.attributes['llm.interrupted']).toBe('abandoned');
    });

    it.each([
      ['left going at stopTracing() (nothing reserved)', 'stop'],
      ['left going by the signal drain at its time limit', 'drain'],
    ])('a stream %s is stopped once dropped, with nothing more recorded', async (_name, path) => {
      if (path === 'stop') {
        (enforceLlmCall as jest.Mock).mockResolvedValue(undefined);
      }
      const stream = new FakeStream(CHUNKS);
      const { traced } = wrap(() => new FakeAPIPromise(stream));
      const result = await traced({ model: MODEL, messages: MSGS, stream: true });
      await (result as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
      await (path === 'stop' ? settleOpenCalls(1000) : drainOpenCalls(20));
      expect(stream.controller.signal.aborted).toBe(false);
      expect(settles).toHaveLength(1);
      // The app drops the stream: what garbage collection then calls.
      (abandonedState() as { collected(): void }).collected();
      expect(stream.controller.signal.aborted).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(settles).toHaveLength(1);
      expect(mockSpan.endCount).toBe(1);
      expect(mockSpan.attributes['llm.interrupted']).toBe('shutdown');
    });

    it('only a stream left going stays watched for being dropped', async () => {
      const registry = (globalThis as unknown as { FinalizationRegistry: { prototype: object } }).FinalizationRegistry;
      const unregister = jest.spyOn(registry.prototype as { unregister(token: object): void }, 'unregister');
      try {
        await readAll(await wrap(() => new FakeAPIPromise(new FakeStream(CHUNKS))).traced({ model: MODEL, messages: MSGS, stream: true }));
        expect(unregister).toHaveBeenCalledWith(abandonedState());

        unregister.mockClear();
        (enforceLlmCall as jest.Mock).mockResolvedValue(undefined);
        const result = await wrap(() => new FakeAPIPromise(new FakeStream(CHUNKS))).traced({ model: MODEL, messages: MSGS, stream: true });
        await (result as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
        await settleOpenCalls(1000);
        expect(unregister).not.toHaveBeenCalledWith(abandonedState());
      } finally {
        unregister.mockRestore();
      }
    });

    it('an open stream whose usage arrived is charged that usage', async () => {
      const stream = new FakeStream([...CHUNKS, chunk('')]);
      const { traced } = wrap(() => new FakeAPIPromise(stream));
      const result = await traced({ model: MODEL, messages: MSGS, stream: true });
      const it = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      for (let i = 0; i < CHUNKS.length; i++) {
        await it.next();
      }
      await settleOpenCalls(1000);
      expect(settles).toEqual([expect.objectContaining({ opts: PRICED })]);
    });

    it('a request still in flight is charged the reservation', async () => {
      const { traced } = wrap(() => new FakeAPIPromise(new Promise(() => undefined)));
      void traced({ model: MODEL, messages: MSGS });
      await settleOpenCalls(1000);
      expect(settles).toEqual([expect.objectContaining({ opts: { actualUsd: RESERVED } })]);
      expect(mockSpan.attributes['llm.interrupted']).toBe('shutdown');
      // Nothing of the response was seen: no estimate.
      expect(mockSpan.attributes['llm.usage.completion_tokens']).toBeUndefined();
      expect(mockSpan.attributes['llm.usage.source']).toBeUndefined();
      expect(mockSpan.endCount).toBe(1);
    });

    it('a finished call is no longer open', async () => {
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      await traced({ model: MODEL, messages: MSGS });
      await settleOpenCalls(1000);
      expect(settles).toEqual([expect.objectContaining({ opts: PRICED })]);
      expect(mockSpan.endCount).toBe(1);
    });

    it('returns by its time limit while a policy check never finishes', async () => {
      (enforceLlmCall as jest.Mock).mockReturnValue(new Promise(() => undefined));
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      void traced({ model: MODEL, messages: MSGS });
      const started = Date.now();
      await settleOpenCalls(100);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    describe('the SIGTERM/SIGINT drain', () => {
      it('lets an open stream finish on its own and settles its usage', async () => {
        const stream = new FakeStream(CHUNKS);
        const { traced } = wrap(() => new FakeAPIPromise(stream));
        const result = await traced({ model: MODEL, messages: MSGS, stream: true });
        const it = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        await it.next();
        let drained = false;
        const draining = drainOpenCalls(1000).then(() => {
          drained = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        expect(stream.controller.signal.aborted).toBe(false);
        // The app reads the rest, as a graceful drain does.
        while (!(await it.next()).done);
        await draining;
        expect(stream.controller.signal.aborted).toBe(false);
        expect(settles).toEqual([expect.objectContaining({ opts: PRICED })]);
        expect(mockSpan.attributes['llm.interrupted']).toBeUndefined();
        expect(mockSpan.attributes['llm.completion']).toBe('Paris.');
        expect(mockSpan.endCount).toBe(1);
      });

      it('settles a stream still open at the time limit at its reservation, without stopping it', async () => {
        const stream = new FakeStream(CHUNKS);
        const { traced } = wrap(() => new FakeAPIPromise(stream));
        const result = await traced({ model: MODEL, messages: MSGS, stream: true });
        const it = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        await it.next();
        await drainOpenCalls(50);
        expect(stream.controller.signal.aborted).toBe(false);
        expect(settles).toEqual([expect.objectContaining({ opts: { actualUsd: RESERVED } })]);
        expect(mockSpan.attributes['llm.interrupted']).toBe('shutdown');
        expectEstimateOnSpan(1);
        expect(mockSpan.endCount).toBe(1);
        // The app still reads the whole stream; its end records nothing more.
        let text = 'Par';
        for (let r = await it.next(); !r.done; r = await it.next()) {
          text += (r.value as { choices: { delta: { content?: string } }[] }).choices[0].delta.content ?? '';
        }
        expect(text).toBe('Paris.');
        await new Promise((resolve) => setImmediate(resolve));
        expect(settles).toHaveLength(1);
        expect(mockSpan.endCount).toBe(1);
      });

      it('returns at once with nothing open', async () => {
        const started = Date.now();
        await drainOpenCalls(5000);
        expect(Date.now() - started).toBeLessThan(1000);
      });
    });

    describe('a policy check pending at shutdown', () => {
      let decide: (decision: Record<string, unknown>) => void;
      let block: (error: Error) => void;

      beforeEach(() => {
        (enforceLlmCall as jest.Mock).mockReturnValue(
          new Promise((resolve, reject) => {
            decide = resolve;
            block = reject;
          })
        );
      });

      it('is waited for, and its reservation charged once, within the time limit', async () => {
        const { create, traced } = wrap(() => new FakeAPIPromise(RESPONSE));
        const result = traced({ model: MODEL, messages: MSGS });
        const settling = settleOpenCalls(1000);
        await new Promise((resolve) => setImmediate(resolve));
        expect(settles).toHaveLength(0);
        decide({ effect: 'allow', id: 'd1', obligations: { reserved_usd: RESERVED } });
        await settling;
        expect(settles).toEqual([
          expect.objectContaining({ decision: expect.objectContaining({ id: 'd1' }), opts: { actualUsd: RESERVED } }),
        ]);
        expect(mockSpan.attributes['llm.interrupted']).toBe('shutdown');
        // The request is never blocked; finishing it later settles nothing more.
        expect(await result).toBe(RESPONSE);
        expect(create).toHaveBeenCalledTimes(1);
        await new Promise((resolve) => setImmediate(resolve));
        expect(settles).toHaveLength(1);
        expect(mockSpan.endCount).toBe(1);
      });

      it('that decides after the time limit still has its reservation charged once', async () => {
        const { create, traced } = wrap(() => new FakeAPIPromise(RESPONSE));
        const result = traced({ model: MODEL, messages: MSGS });
        await settleOpenCalls(20);
        expect(settles).toHaveLength(0);
        decide({ effect: 'allow', id: 'd1', obligations: { reserved_usd: RESERVED } });
        expect(await result).toBe(RESPONSE);
        await new Promise((resolve) => setImmediate(resolve));
        expect(create).toHaveBeenCalledTimes(1);
        expect(settles).toEqual([expect.objectContaining({ opts: { actualUsd: RESERVED } })]);
        expect(mockSpan.endCount).toBe(1);
      });

      it.each([
        ['with a reservation, is stopped', { effect: 'allow', id: 'd1', obligations: { reserved_usd: RESERVED } }, true],
        ['with nothing reserved, goes on until dropped', { effect: 'allow', id: 'd1' }, false],
      ])('whose stream arrives after the call ended at stopTracing(), %s', async (_name, decision, stopped) => {
        const stream = new FakeStream(CHUNKS);
        const { traced } = wrap(() => new FakeAPIPromise(stream));
        const result = traced({ model: MODEL, messages: MSGS, stream: true });
        const settling = settleOpenCalls(1000);
        decide(decision);
        await settling;
        expect(await result).toBe(stream);
        expect(stream.controller.signal.aborted).toBe(stopped);
        if (!stopped) {
          (abandonedState() as { collected(): void }).collected();
          expect(stream.controller.signal.aborted).toBe(true);
        }
        expect(settles).toHaveLength(1);
        expect(mockSpan.endCount).toBe(1);
      });

      it('at the signal drain time limit is waited for a little, so its span ends first', async () => {
        const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
        void traced({ model: MODEL, messages: MSGS });
        // Decides after the 100 ms limit, within the grace (as long as the limit, at most 1 s).
        const decided = new Promise<void>((resolve) =>
          setTimeout(() => {
            decide({ effect: 'allow', id: 'd1', obligations: { reserved_usd: RESERVED } });
            resolve();
          }, 150)
        );
        await drainOpenCalls(100);
        // Ended before the drain returned, so before the hook shuts the tracer down.
        expect(mockSpan.endCount).toBe(1);
        await decided;
        expect(settles).toEqual([expect.objectContaining({ opts: { actualUsd: RESERVED } })]);
      });

      it('that never decides holds the signal drain at most its limit again (and 1 s) past it', async () => {
        const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
        void traced({ model: MODEL, messages: MSGS });
        const started = Date.now();
        await drainOpenCalls(100);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(mockSpan.endCount).toBe(0);
      });

      it('that blocks the call records the block and charges nothing', async () => {
        const { create, traced } = wrap(() => new FakeAPIPromise(RESPONSE));
        const result = traced({ model: MODEL, messages: MSGS });
        const settling = settleOpenCalls(1000);
        const error = new Error('blocked by policy');
        block(error);
        await settling;
        await expect(result).rejects.toBe(error);
        expect(create).not.toHaveBeenCalled();
        expect(settles).toEqual([expect.objectContaining({ opts: { release: true } })]);
        expect(mockSpan.attributes['llm.interrupted']).toBeUndefined();
        expect(mockSpan.status).toBe(SpanStatus.ERROR);
        expect(mockSpan.statusDescription).toBe('blocked by policy');
        expect(mockSpan.recordException).toHaveBeenCalledWith(error);
        expect(mockSpan.endCount).toBe(1);
      });
    });
  });
});
