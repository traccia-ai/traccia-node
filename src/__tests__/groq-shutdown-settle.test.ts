/**
 * Groq calls settled at shutdown reach the policy server with the credentials passed to init(),
 * also when those are the only credentials (no environment or config file), and also when a
 * settle starts after stopTracing() has returned. Uses the real init(), stopTracing() and pep.
 */

import type { AxiosInstance } from 'axios';
import { getTracerProvider, init, stopTracing } from '../auto';
import { getClientConfig } from '../config/client-config';
import { loadConfig } from '../config/config';
import { runIdentity } from '../config/runtime-config';
import { _resetPepStateForTests, _setPepHttpClientForTests } from '../governance/pep';
import { wrapGroqChatCompletionsCreate } from '../instrumentation/groq';
import { ISpanExporter } from '../types';

const API_KEY = 'tr_test_init_only_key';
const ENDPOINT = 'http://127.0.0.1:9/v1/traces';
const SETTLE_URL = 'http://127.0.0.1:9/api/v1/policy/settle';
const CHECK_URL = 'http://127.0.0.1:9/api/v1/policy/check';
const CRED_ENV = ['TRACCIA_API_KEY', 'TRACCIA_ENDPOINT', 'AGENT_DASHBOARD_API_KEY', 'AGENT_DASHBOARD_ENDPOINT'];
const MODEL = 'llama-3.3-70b-versatile';
const MSGS = [{ role: 'user', content: 'Capital of France?' }];
const DECISION = { effect: 'allow', would_have: false, id: 'd1', obligations: { reserved_usd: 0.5 } };

const exporter: ISpanExporter = {
  export: async () => true,
  shutdown: async () => undefined,
};

/** groq-sdk's Stream as the wrapper sees it: iterated through its `iterator` field. */
function openStream(): { controller: AbortController; iterator: () => AsyncIterator<unknown> } {
  const controller = new AbortController();
  return {
    controller,
    iterator: async function* (): AsyncGenerator<unknown> {
      yield { model: MODEL, choices: [{ delta: { content: 'Par' }, finish_reason: null }] };
      // The rest never arrives before shutdown.
      await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve()));
    } as unknown as () => AsyncIterator<unknown>,
  };
}

describe('Groq calls settled at shutdown with init() credentials only', () => {
  const saved: Record<string, string | undefined> = {};
  let post: jest.Mock;
  let check: () => Promise<unknown>;

  const settles = (): Array<{ url: string; body: Record<string, unknown>; auth: string }> =>
    post.mock.calls
      .filter((call) => call[0] === SETTLE_URL)
      .map((call) => ({
        url: call[0] as string,
        body: call[1] as Record<string, unknown>,
        auth: (call[2] as { headers: Record<string, string> }).headers.Authorization,
      }));

  beforeAll(() => {
    for (const name of CRED_ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    // Precondition: no env/file credentials anywhere, so init() is the only source.
    expect(loadConfig().tracing.api_key).toBeFalsy();
  });

  afterAll(() => {
    for (const name of CRED_ENV) {
      if (saved[name] !== undefined) process.env[name] = saved[name];
    }
  });

  beforeEach(async () => {
    check = async () => ({ status: 200, data: DECISION });
    post = jest.fn(async (url: string) => (url === CHECK_URL ? check() : { status: 200, data: {} }));
    _setPepHttpClientForTests({ post } as unknown as AxiosInstance);
    await init({
      apiKey: API_KEY,
      endpoint: ENDPOINT,
      agentId: 'agent-1',
      loadEnv: false,
      exporter,
      enableCostTracking: false,
    });
  });

  afterEach(async () => {
    await stopTracing();
    _resetPepStateForTests();
  });

  it('stopTracing() settles a stream still open, with the init() credentials', async () => {
    const traced = wrapGroqChatCompletionsCreate(jest.fn(async (_body: unknown) => openStream()), null);
    const stream = (await runIdentity({ pepEnabled: true }, () =>
      traced({ model: MODEL, messages: MSGS, stream: true })
    )) as { controller: AbortController; iterator: () => AsyncIterator<unknown> };
    await stream.iterator().next();

    await stopTracing();

    // Stopped, so Groq stops generating what the reservation is charged for.
    expect(stream.controller.signal.aborted).toBe(true);
    // Cleared, but only after the settle above read them.
    expect(getClientConfig()).toBeUndefined();
    expect(settles()).toEqual([
      {
        url: SETTLE_URL,
        body: expect.objectContaining({ agent_id: 'agent-1', reserved_usd: 0.5, actual_usd: 0.5, release: false }),
        auth: `Bearer ${API_KEY}`,
      },
    ]);
  });

  it('stopTracing() ends the span of an ungoverned stream without stopping it', async () => {
    const traced = wrapGroqChatCompletionsCreate(jest.fn(async (_body: unknown) => openStream()), null);
    // No govern() run: no policy check, nothing reserved.
    const stream = (await traced({ model: MODEL, messages: MSGS, stream: true })) as {
      controller: AbortController;
      iterator: () => AsyncIterator<unknown>;
    };
    await stream.iterator().next();

    await stopTracing();

    expect(post).not.toHaveBeenCalled();
    expect(stream.controller.signal.aborted).toBe(false);
  });

  it('a call whose policy check outlives stopTracing() is settled once the check decides', async () => {
    let decide: () => void = () => undefined;
    check = () =>
      new Promise((resolve) => {
        decide = () => resolve({ status: 200, data: DECISION });
      });
    const create = jest.fn(async (_body: unknown) => ({
      model: MODEL,
      choices: [{ finish_reason: 'stop', message: { content: 'Paris.' } }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    }));
    const traced = wrapGroqChatCompletionsCreate(create, null);
    const pending = runIdentity({ pepEnabled: true }, () => traced({ model: MODEL, messages: MSGS }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(post).toHaveBeenCalledTimes(1); // the check, still pending

    // Returns by its time limit while the check is still pending.
    await stopTracing(50);
    expect(settles()).toHaveLength(0);

    decide();
    await pending;
    await new Promise((resolve) => setImmediate(resolve));

    // The provider call was not blocked; the reservation it made is charged once (the call
    // was still open at shutdown, so its outcome is unknown to the settle).
    expect(create).toHaveBeenCalledTimes(1);
    expect(settles()).toEqual([
      {
        url: SETTLE_URL,
        body: expect.objectContaining({ agent_id: 'agent-1', reserved_usd: 0.5, actual_usd: 0.5, release: false }),
        auth: `Bearer ${API_KEY}`,
      },
    ]);
  });

  it('concurrent stopTracing() calls share one shutdown while a policy check is pending', async () => {
    let decide: () => void = () => undefined;
    check = () =>
      new Promise((resolve) => {
        decide = () => resolve({ status: 200, data: DECISION });
      });
    const create = jest.fn(async (_body: unknown) => ({
      model: MODEL,
      choices: [{ finish_reason: 'stop', message: { content: 'Paris.' } }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    }));
    const traced = wrapGroqChatCompletionsCreate(create, null);
    const pending = runIdentity({ pepEnabled: true }, () => traced({ model: MODEL, messages: MSGS }));
    await new Promise((resolve) => setImmediate(resolve));
    const shutdown = jest.spyOn(getTracerProvider(), 'shutdown');

    // The first waits for the pending check; the second, with a shorter limit, must not end
    // the shutdown under it.
    const first = stopTracing();
    const second = stopTracing(50);
    await new Promise((resolve) => setTimeout(resolve, 100));
    decide();
    await pending;
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(settles()).toHaveLength(1);
    expect(getClientConfig()).toBeUndefined();
  });

  it('a later init() and stopTracing() work again after a shutdown', async () => {
    const first = getTracerProvider();
    await stopTracing();

    await init({ apiKey: API_KEY, endpoint: ENDPOINT, agentId: 'agent-1', loadEnv: false, exporter, enableCostTracking: false });
    const provider = getTracerProvider();
    expect(provider).not.toBe(first);
    const shutdown = jest.spyOn(provider, 'shutdown');
    const traced = wrapGroqChatCompletionsCreate(jest.fn(async (_body: unknown) => openStream()), null);
    const stream = (await runIdentity({ pepEnabled: true }, () =>
      traced({ model: MODEL, messages: MSGS, stream: true })
    )) as { controller: AbortController; iterator: () => AsyncIterator<unknown> };
    await stream.iterator().next();

    await stopTracing();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(stream.controller.signal.aborted).toBe(true);
    expect(settles()).toEqual([
      {
        url: SETTLE_URL,
        body: expect.objectContaining({ agent_id: 'agent-1', reserved_usd: 0.5, actual_usd: 0.5, release: false }),
        auth: `Bearer ${API_KEY}`,
      },
    ]);
  });
});
