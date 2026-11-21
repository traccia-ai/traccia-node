/**
 * The SIGTERM/SIGINT listener init() registers replaces Node's default exit, so the app keeps
 * running after the signal, often draining its own work. It must never cut off the app's Groq
 * calls: a stream the app finishes reading settles at its usage, and one still open at the time
 * limit is settled at its reservation without being stopped. Uses the real init(), processors,
 * pep and groq-sdk; only fetch, the pep HTTP client and the exporter are fakes.
 */

import type { AxiosInstance } from 'axios';
import Groq from 'groq-sdk';
import { getTracerProvider, init, stopTracing } from '../auto';
import { runIdentity } from '../config/runtime-config';
import { SHUTDOWN_SETTLE_TIMEOUT_MS, _resetPepStateForTests, _setPepHttpClientForTests } from '../governance/pep';
import { ISpan, ISpanExporter } from '../types';

const SETTLE_URL = 'http://127.0.0.1:9/api/v1/policy/settle';
const MODEL = 'llama-3.3-70b-versatile';
const USAGE = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
const CHUNKS = [
  { id: 'c1', model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  { id: 'c1', model: MODEL, choices: [{ index: 0, delta: { content: 'Par' } }] },
  { id: 'c1', model: MODEL, choices: [{ index: 0, delta: { content: 'is.' } }] },
  { id: 'c1', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], x_groq: { id: 'r', usage: USAGE } },
];
const sse = (chunk: unknown): Uint8Array => new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);

type Settle = Record<string, unknown>;

describe("init()'s SIGTERM/SIGINT hook", () => {
  const exported: ISpan[] = [];
  const exporter: ISpanExporter = {
    export: async (spans: ISpan[]) => {
      exported.push(...spans);
      return true;
    },
    shutdown: async () => undefined,
  };
  let post: jest.Mock;
  let hook: () => Promise<void>;
  /** The AbortSignal of each Groq request. */
  const signals: AbortSignal[] = [];
  /** Sends the rest of the open stream. */
  let finishStream: () => void;
  let client: Groq;

  const settles = (): Settle[] => post.mock.calls.filter((c) => c[0] === SETTLE_URL).map((c) => c[1] as Settle);
  const groqSpans = (): Array<Record<string, unknown>> =>
    exported.filter((s) => s.name === 'llm.groq.chat.completions').map((s) => s.attributes);

  beforeAll(async () => {
    const before = process.listeners('SIGTERM');
    post = jest.fn();
    _setPepHttpClientForTests({ post } as unknown as AxiosInstance);
    await init({ apiKey: 'tr_test_key', endpoint: 'http://127.0.0.1:9/v1/traces', agentId: 'agent-1', loadEnv: false, exporter });
    const added = process.listeners('SIGTERM').filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    hook = added[0] as () => Promise<void>;
    expect(process.listeners('SIGINT')).toContain(hook);
    await stopTracing();
  });

  beforeEach(async () => {
    exported.length = 0;
    signals.length = 0;
    post = jest.fn(async (url: string) =>
      url === SETTLE_URL ? { status: 200, data: {} } : { status: 200, data: { effect: 'allow', would_have: false, obligations: { reserved_usd: 0.5 } } }
    );
    _setPepHttpClientForTests({ post } as unknown as AxiosInstance);
    await init({ apiKey: 'tr_test_key', endpoint: 'http://127.0.0.1:9/v1/traces', agentId: 'agent-1', loadEnv: false, exporter });
    // A Groq stream that sends its first two chunks, then the rest when finishStream() is called.
    const fetch = async (_url: unknown, request: { body: string; signal: AbortSignal }): Promise<Response> => {
      signals.push(request.signal);
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(sse(CHUNKS[0]));
          controller.enqueue(sse(CHUNKS[1]));
          finishStream = (): void => {
            controller.enqueue(sse(CHUNKS[2]));
            controller.enqueue(sse(CHUNKS[3]));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          };
          request.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    client = new Groq({ apiKey: 'test', fetch: fetch as never, maxRetries: 0 });
  });

  afterEach(async () => {
    // The hook shut the provider down but left the runtime started; reset it for the next init().
    await stopTracing();
    _resetPepStateForTests();
  });

  async function openStream(): Promise<AsyncIterator<unknown>> {
    const stream = await runIdentity({ pepEnabled: true }, () =>
      client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: 'Capital of France?' }], stream: true })
    );
    const it = (stream as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    await it.next();
    await it.next();
    return it;
  }

  async function readRest(it: AsyncIterator<unknown>): Promise<string> {
    let text = '';
    for (let r = await it.next(); !r.done; r = await it.next()) {
      text += (r.value as { choices: Array<{ delta?: { content?: string } }> }).choices[0]?.delta?.content ?? '';
    }
    return text;
  }

  it('lets a stream the app is draining finish, and settles it at its usage', async () => {
    const it = await openStream();
    // The app's own graceful handler goes on reading after the signal.
    const appDrain = jest.fn();
    process.once('SIGTERM', appDrain);
    try {
      const hooked = hook();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(signals[0].aborted).toBe(false);
      expect(settles()).toHaveLength(0);
      finishStream();
      expect(await readRest(it)).toBe('is.');
      const started = Date.now();
      await hooked;
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      process.removeListener('SIGTERM', appDrain);
    }

    expect(signals[0].aborted).toBe(false);
    expect(settles()).toEqual([expect.objectContaining({ input_tokens: 12, output_tokens: 3, reserved_usd: 0.5 })]);
    expect(settles()[0].actual_usd).not.toBe(0.5);
    const [span] = groqSpans();
    expect(span['llm.interrupted']).toBeUndefined();
    expect(span['llm.usage.source']).toBe('provider_usage');
    expect(span['llm.completion']).toBe('Paris.');
  });

  it(
    'settles a stream still open at the time limit at its reservation, without stopping it',
    async () => {
      const it = await openStream();
      await hook();

      expect(signals[0].aborted).toBe(false);
      expect(settles()).toEqual([expect.objectContaining({ actual_usd: 0.5, reserved_usd: 0.5, release: false })]);
      const [span] = groqSpans();
      expect(span['llm.interrupted']).toBe('shutdown');
      // The span keeps what it observed: 'Capital of France?' (4 tokens) in, 'Par' (1 token) out.
      expect(span).toMatchObject({ 'llm.usage.prompt_tokens': 4, 'llm.usage.completion_tokens': 1, 'llm.usage.source': 'estimated' });

      // The app still reads the whole stream; its end records nothing more.
      finishStream();
      expect(await readRest(it)).toBe('is.');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settles()).toHaveLength(1);
      expect(groqSpans()).toHaveLength(1);
    },
    SHUTDOWN_SETTLE_TIMEOUT_MS + 10_000
  );

  it('waits for a stopTracing() in progress, and the provider is shut down once', async () => {
    await openStream();
    const shutdown = jest.spyOn(getTracerProvider(), 'shutdown');

    const stopping = stopTracing();
    await hook();
    await stopping;

    // stopTracing() stops the governed stream and settles it; the hook adds nothing.
    expect(signals[0].aborted).toBe(true);
    expect(settles()).toEqual([expect.objectContaining({ actual_usd: 0.5, reserved_usd: 0.5, release: false })]);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('a stopTracing() during the hook shuts the provider down once', async () => {
    await openStream();
    const shutdown = jest.spyOn(getTracerProvider(), 'shutdown');

    const hooked = hook();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The app stops tracing while the hook waits for its stream: that stops the stream.
    await stopTracing();
    await hooked;

    expect(signals[0].aborted).toBe(true);
    expect(settles()).toEqual([expect.objectContaining({ actual_usd: 0.5, reserved_usd: 0.5, release: false })]);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('a second signal during the hook shares its shutdown', async () => {
    const shutdown = jest.spyOn(getTracerProvider(), 'shutdown');

    const first = hook();
    const second = hook();
    await first;

    expect(second).toBe(first);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
