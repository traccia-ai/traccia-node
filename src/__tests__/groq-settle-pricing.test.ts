/**
 * Successful Groq calls settle the Spend Cap with their actual cost and token counts, priced by
 * the real cost resolver from the shipped snapshot (instrumentation-groq.test.ts mocks it).
 */
import { wrapGroqChatCompletionsCreate } from '../instrumentation/groq';
import { getTracer } from '../auto';
import { enforceLlmCall, finishLlmCall } from '../governance/pep';
import { getMetricsRecorder } from '../metrics/recorder';
import { loadPricingWithSource, readBundledSnapshot } from '../config/pricing-config';
import { CostResolver, getResolver, setResolver } from '../processor/cost-resolver';

jest.mock('../auto', () => ({
  getTracer: jest.fn(),
}));

jest.mock('../governance/pep', () => {
  const actual = jest.requireActual('../governance/pep');
  return {
    ...actual,
    enforceLlmCall: jest.fn(),
    finishLlmCall: jest.fn(),
  };
});

jest.mock('../metrics/recorder', () => ({
  getMetricsRecorder: jest.fn(),
}));

const MODEL = 'llama-3.3-70b-versatile';
const MSGS = [{ role: 'user', content: 'Capital of France?' }];
const USAGE = { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 };
// groq/llama-3.3-70b-versatile in the shipped snapshot: $0.00059 and $0.00079 per 1K tokens.
const GROQ_COST = (11 * 0.00059 + 5 * 0.00079) / 1000;

const settled = (actualUsd: number): Record<string, unknown> => ({
  actualUsd: expect.closeTo(actualUsd, 12),
  model: MODEL,
  vendor: 'groq',
  inputTokens: 11,
  outputTokens: 5,
});

async function* chunks(): AsyncGenerator<unknown> {
  yield { model: MODEL, choices: [{ delta: { content: 'Paris.' }, finish_reason: null }] };
  yield { model: MODEL, choices: [{ delta: {}, finish_reason: 'stop' }], x_groq: { usage: USAGE } };
}

describe('Groq settlement with real pricing', () => {
  const settles: unknown[] = [];
  let previous: CostResolver;

  beforeAll(() => {
    previous = getResolver();
  });

  beforeEach(() => {
    settles.length = 0;
    const span = { attributes: {}, setAttribute: jest.fn(), end: jest.fn(), recordException: jest.fn() };
    (getTracer as jest.Mock).mockReturnValue({ startSpan: jest.fn(() => span) });
    (getMetricsRecorder as jest.Mock).mockReturnValue({
      recordTokenUsage: jest.fn(),
      recordDuration: jest.fn(),
      recordCost: jest.fn(),
      recordException: jest.fn(),
    });
    (enforceLlmCall as jest.Mock).mockResolvedValue({ effect: 'allow', id: 'd1' });
    (finishLlmCall as jest.Mock).mockImplementation(async (_decision: unknown, opts: unknown) => {
      settles.push(opts);
    });
    setResolver(new CostResolver(readBundledSnapshot()!.models));
  });

  afterAll(() => {
    setResolver(previous);
  });

  it('a completed call settles its Groq price and token counts', async () => {
    const traced = wrapGroqChatCompletionsCreate(
      jest.fn(async (_body: unknown) => ({ model: MODEL, usage: USAGE, choices: [{ finish_reason: 'stop', message: { content: 'Paris.' } }] })),
      null
    );
    await traced({ model: MODEL, messages: MSGS });
    expect(settles).toEqual([settled(GROQ_COST)]);
  });

  it('a stream read to the end settles its Groq price and token counts', async () => {
    // groq-sdk's Stream iterates through its `iterator` field, which the wrapper replaces.
    const stream = {
      controller: new AbortController(),
      iterator: (): AsyncIterator<unknown> => chunks(),
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return this.iterator();
      },
    };
    const traced = wrapGroqChatCompletionsCreate(jest.fn(async (_body: unknown) => stream), null);
    for await (const _ of (await traced({ model: MODEL, messages: MSGS, stream: true })) as AsyncIterable<unknown>) {
      // read to the end
    }
    expect(settles).toEqual([settled(GROQ_COST)]);
  });

  it('settles at the configured price when the user overrides it', async () => {
    const [table] = await loadPricingWithSource({ [MODEL]: { inputCost: 1.5, outputCost: 1.5 } });
    setResolver(new CostResolver(table));
    const traced = wrapGroqChatCompletionsCreate(
      jest.fn(async (_body: unknown) => ({ model: MODEL, usage: USAGE, choices: [{ finish_reason: 'stop', message: { content: 'Paris.' } }] })),
      null
    );
    await traced({ model: MODEL, messages: MSGS });
    expect(settles).toEqual([settled((16 * 1.5) / 1000)]);
  });
});
