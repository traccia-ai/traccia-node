import { wrapGroqChatCompletionsCreate } from '../instrumentation/groq';
import { getTracer } from '../auto';
import { enforceLlmCall, finishLlmCall } from '../governance/pep';
import { getAgentId, pepEnabled, runIdentity } from '../config/runtime-config';
import { getCurrentSpan } from '../context/context';
import { SpanStatus, ISpan } from '../types';

jest.mock('../auto', () => ({
  getTracer: jest.fn(),
}));

jest.mock('../governance/pep', () => ({
  enforceLlmCall: jest.fn(),
  finishLlmCall: jest.fn(),
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
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('../instrumentation/groq');
        expect(() => fresh.patchGroq()).not.toThrow();
        expect(fresh.patchGroq()).toBe(false);
        jest.dontMock('groq-sdk/resources/chat/completions');
      });
    });

    it('does not wrap an already wrapped create', () => {
      const { traced } = wrap(() => new FakeAPIPromise(RESPONSE));
      expect(wrapGroqChatCompletionsCreate(traced, null)).toBe(traced);
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
      expect(settles[0].opts).toBeUndefined();
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
      expect(settles).toEqual([expect.objectContaining({ opts: undefined })]);
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
    });

    it('a loop stopped early records the partial text without releasing', async () => {
      const stream = new FakeStream(CHUNKS);
      const { traced } = streamWrap(stream);
      const result = await traced({ model: 'm', messages: MSGS, stream: true });
      for await (const _ of result) {
        break;
      }
      expect(stream.returned).toBe(true);
      expect(mockSpan.attributes['llm.completion']).toBe('Par');
      expect(mockSpan.status).toBeUndefined();
      expect(settles).toEqual([expect.objectContaining({ opts: undefined })]);
      expect(mockSpan.endCount).toBe(1);
    });

    it('an aborted stream is marked aborted and releases the reservation', async () => {
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
      expect(mockSpan.status).toBe(SpanStatus.ERROR);
      expect(mockSpan.statusDescription).toBe('aborted');
      expect(settles).toEqual([expect.objectContaining({ opts: { release: true } })]);
      expect(mockSpan.endCount).toBe(1);
    });

    it('an error mid-stream is recorded, releases, and propagates', async () => {
      const error = new Error('connection reset');
      const { traced } = streamWrap(new FakeStream(CHUNKS.slice(0, 1), error));
      const result = await traced({ model: 'm', messages: MSGS, stream: true });
      await expect(readAll(result)).rejects.toBe(error);
      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.status).toBe(SpanStatus.ERROR);
      expect(mockSpan.statusDescription).toBe('connection reset');
      expect(settles).toEqual([expect.objectContaining({ opts: { release: true } })]);
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
