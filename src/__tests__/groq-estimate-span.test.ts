/**
 * A Groq call settled from an estimate (no usage reported) records that estimate on its span,
 * and the span's cost, from the real processor chain init() sets up, equals the settled cost.
 * Uses the real init(), processors, pricing and pep; only the HTTP client and exporter are fakes.
 */

import type { AxiosInstance } from 'axios';
import { init, stopTracing } from '../auto';
import { runIdentity } from '../config/runtime-config';
import { _resetPepStateForTests, _setPepHttpClientForTests } from '../governance/pep';
import { wrapGroqChatCompletionsCreate } from '../instrumentation/groq';
import { ISpan, ISpanExporter, SDKConfig } from '../types';

const ENDPOINT = 'http://127.0.0.1:9/v1/traces';
const SETTLE_URL = 'http://127.0.0.1:9/api/v1/policy/settle';
const MODEL = 'llama-3.3-70b-versatile';
/** 'Capital of France?' is 18 characters: 4 estimated prompt tokens. */
const MSGS = [{ role: 'user', content: 'Capital of France?' }];
const PROMPT_ESTIMATE = 4;
const RESERVED = 0.5;
const DECISION = { effect: 'allow', would_have: false, id: 'd1', obligations: { reserved_usd: RESERVED } };

type Settle = { actual_usd?: number; input_tokens?: number; output_tokens?: number; model?: string };

function chunk(delta: Record<string, unknown>): Record<string, unknown> {
  return { model: MODEL, choices: [{ delta, finish_reason: null }] };
}

/** groq-sdk's Stream as the wrapper sees it: iterated through its `iterator` field. */
function fakeStream(chunks: unknown[], endless = false): AsyncIterable<unknown> & { controller: AbortController } {
  const controller = new AbortController();
  const stream = {
    controller,
    iterator: async function* (): AsyncGenerator<unknown> {
      try {
        for (const c of chunks) {
          yield c;
        }
        if (endless) {
          await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve()));
        }
      } finally {
        controller.abort();
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return stream.iterator();
    },
  };
  return stream;
}

describe('Groq estimated usage on the span', () => {
  const exported: ISpan[] = [];
  const exporter: ISpanExporter = {
    export: async (spans: ISpan[]) => {
      exported.push(...spans);
      return true;
    },
    shutdown: async () => undefined,
  };
  let post: jest.Mock;

  const settles = (): Settle[] =>
    post.mock.calls.filter((call) => call[0] === SETTLE_URL).map((call) => call[1] as Settle);

  /** The span's attributes once every processor ran, as exported. */
  const groqSpan = (): Record<string, unknown> => {
    const spans = exported.filter((s) => s.name === 'llm.groq.chat.completions');
    expect(spans).toHaveLength(1);
    return spans[0].attributes;
  };

  async function start(config: SDKConfig = {}): Promise<void> {
    await init({
      apiKey: 'tr_test_key',
      endpoint: ENDPOINT,
      agentId: 'agent-1',
      loadEnv: false,
      exporter,
      ...config,
    });
  }

  beforeEach(() => {
    exported.length = 0;
    post = jest.fn(async (url: string) => (url === SETTLE_URL ? { status: 200, data: {} } : { status: 200, data: DECISION }));
    _setPepHttpClientForTests({ post } as unknown as AxiosInstance);
  });

  afterEach(async () => {
    await stopTracing();
    _resetPepStateForTests();
  });

  function expectEstimate(attrs: Record<string, unknown>, output: number): void {
    expect(attrs).toMatchObject({
      'llm.usage.prompt_tokens': PROMPT_ESTIMATE,
      'llm.usage.input_tokens': PROMPT_ESTIMATE,
      'llm.usage.completion_tokens': output,
      'llm.usage.output_tokens': output,
      'llm.usage.prompt_source': 'estimated',
      'llm.usage.completion_source': 'estimated',
      'llm.usage.source': 'estimated',
    });
  }

  it('a reasoning-only stream stopped early records the 1,000 reasoning tokens it is charged', async () => {
    await start();
    const traced = wrapGroqChatCompletionsCreate(
      jest.fn(async (_body: unknown) => fakeStream([chunk({ reasoning: 'r'.repeat(4000) })], true)),
      null
    );
    const stream = (await runIdentity({ pepEnabled: true }, () =>
      traced({ model: MODEL, messages: MSGS, stream: true })
    )) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      break;
    }
    await stopTracing();

    const [settle] = settles();
    expect(settle).toMatchObject({ model: MODEL, input_tokens: PROMPT_ESTIMATE, output_tokens: 1000 });
    expect(settle.actual_usd).toBeGreaterThan(0);
    const attrs = groqSpan();
    expectEstimate(attrs, 1000);
    expect(attrs['llm.cost.usd']).toBe(settle.actual_usd);
    expect(attrs['llm.cost.source']).toBe('estimated');
  });

  it('a reply with only a tool call and no usage records the tool call arguments it is charged', async () => {
    await start();
    const args = '{"city":"Paris","unit":"celsius"}'; // 33 characters: 9 tokens
    const traced = wrapGroqChatCompletionsCreate(
      jest.fn(async (_body: unknown) => ({
        model: MODEL,
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { role: 'assistant', content: null, tool_calls: [{ function: { name: 'weather', arguments: args } }] },
          },
        ],
      })),
      null
    );
    await runIdentity({ pepEnabled: true }, () => traced({ model: MODEL, messages: MSGS }));
    await stopTracing();

    const [settle] = settles();
    expect(settle).toMatchObject({ input_tokens: PROMPT_ESTIMATE, output_tokens: 9 });
    const attrs = groqSpan();
    expectEstimate(attrs, 9);
    expect(attrs['llm.cost.usd']).toBe(settle.actual_usd);
  });

  it('a pricing override prices the span estimate as it prices the settlement', async () => {
    await start({ pricingOverride: { [MODEL]: { inputCost: 1.5, outputCost: 1.5 } } });
    const traced = wrapGroqChatCompletionsCreate(
      // 'Paris is the capital.' is 21 characters: 6 tokens. No usage chunk.
      jest.fn(async (_body: unknown) => fakeStream([chunk({ content: 'Paris is the capital.' })])),
      null
    );
    const stream = (await runIdentity({ pepEnabled: true }, () =>
      traced({ model: MODEL, messages: MSGS, stream: true })
    )) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      // read to the end
    }
    await stopTracing();

    const [settle] = settles();
    expect(settle.actual_usd).toBeCloseTo(((PROMPT_ESTIMATE + 6) * 1.5) / 1000, 12);
    const attrs = groqSpan();
    expectEstimate(attrs, 6);
    expect(attrs['llm.cost.usd']).toBe(settle.actual_usd);
    expect(attrs['llm.pricing.source']).toBe('override');
  });

  it('a stream open at shutdown is charged its reservation and records the estimate of what it streamed', async () => {
    await start();
    const traced = wrapGroqChatCompletionsCreate(
      jest.fn(async (_body: unknown) => fakeStream([chunk({ reasoning: 'r'.repeat(4000) })], true)),
      null
    );
    const stream = (await runIdentity({ pepEnabled: true }, () =>
      traced({ model: MODEL, messages: MSGS, stream: true })
    )) as AsyncIterable<unknown>;
    await stream[Symbol.asyncIterator]().next();
    await stopTracing();

    expect(settles()).toEqual([expect.objectContaining({ actual_usd: RESERVED })]);
    const attrs = groqSpan();
    expect(attrs['llm.interrupted']).toBe('shutdown');
    expectEstimate(attrs, 1000);
  });

  it('a request in flight at shutdown records no estimate', async () => {
    await start();
    const traced = wrapGroqChatCompletionsCreate(jest.fn((_body: unknown) => new Promise(() => undefined)), null);
    void runIdentity({ pepEnabled: true }, () => traced({ model: MODEL, messages: MSGS }));
    await new Promise((resolve) => setImmediate(resolve));
    await stopTracing();

    expect(settles()).toEqual([expect.objectContaining({ actual_usd: RESERVED })]);
    const attrs = groqSpan();
    expect(attrs['llm.interrupted']).toBe('shutdown');
    expect(attrs['llm.usage.completion_tokens']).toBeUndefined();
    expect(attrs['llm.usage.source']).not.toBe('estimated');
  });

  it("an estimate for a model without a Groq price is left to the server, never priced at another provider's", async () => {
    // The table prices gemma2-9b-it only under fireworks_ai.
    await start();
    const traced = wrapGroqChatCompletionsCreate(
      jest.fn(async (_body: unknown) => ({
        model: 'gemma2-9b-it',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Paris is the capital.' } }],
      })),
      null
    );
    await runIdentity({ pepEnabled: true }, () => traced({ model: 'gemma2-9b-it', messages: MSGS }));
    await stopTracing();

    const [settle] = settles();
    expect(settle).toMatchObject({ model: 'gemma2-9b-it', input_tokens: PROMPT_ESTIMATE, output_tokens: 6 });
    expect(settle.actual_usd).toBeUndefined();
    const attrs = groqSpan();
    expectEstimate(attrs, 6);
    expect(attrs['agent.id']).toBe('agent-1'); // the agent enricher ran
    expect(attrs['llm.cost.usd']).toBeUndefined();
  });
});
