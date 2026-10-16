import { wrapGroqChatCompletionsCreate } from '../instrumentation/groq';
import { getTracer } from '../auto';
import { enforceLlmCall, finishLlmCall } from '../governance/pep';
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
  };
});

jest.mock('../processor/cost-processor', () => ({
  computeCost: jest.fn(),
}));

jest.mock('../metrics/recorder', () => ({
  getMetricsRecorder: jest.fn(),
}));

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

/** Settlement estimated from `outputTokens` of streamed text, with no usage reported. */
function estimated(outputTokens: number): Record<string, unknown> {
  return { model: MODEL, vendor: 'groq', inputTokens: PROMPT_ESTIMATE, outputTokens };
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
        jest.doMock('groq-sdk/resources/chat/completions', () => ({ Completions }), {
          virtual: true,
        });
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
        jest.doMock(
          'groq-sdk/resources/chat/completions',
          () => {
            throw new Error("Cannot find module 'groq-sdk'");
          },
          { virtual: true }
        );
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
      expect(enforceLlmCall).toHaveBeenCalledWith(expect.objectContaining({ model: MODEL }), {
        vendor: 'groq',
      });
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
      expect(enforceLlmCall).toHaveBeenCalledWith(
        expect.objectContaining({ model: MODEL }),
        { vendor: 'groq' }
      );
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
      // 'Paris.' is 6 characters: 2 output tokens.
      expect(settles[0].opts).toEqual(estimated(2));
      expect(computeCost).not.toHaveBeenCalled();
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
    });

    it('a stream that ended without output or usage settles a one-token estimate', async () => {
      const { traced } = streamWrap(new FakeStream([chunk(undefined)]));
      await readAll(await traced({ model: MODEL, messages: MSGS, stream: true }));
      expect(settles[0].opts).toEqual(estimated(1));
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
});
