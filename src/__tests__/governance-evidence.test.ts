/**
 * TRC-289: freshness evidence must not cross agent/run boundaries, and per-trace
 * evidence must not outlive its run.
 */
import axios from 'axios';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { observe } from '../instrumentation/decorator';
import { expressMiddleware } from '../instrumentation/express';
import { fastifyPlugin } from '../instrumentation/fastify';
import { runIdentity } from '../config/runtime-config';
import { govern } from '../governance/govern';
import { getCurrentSpan } from '../context/context';
import { _resetPepStateForTests, _setPepHttpClientForTests, enforceLlmCall, notePromptAttributes } from '../governance/pep';
import { EvidenceStore, lastReads, promptByTrace, retrievalByTrace } from '../governance/evidence';

jest.mock('../config/config', () => ({
  loadConfig: jest.fn(() => ({
    tracing: { api_key: 'test-key', endpoint: 'https://app.traccia.ai/v1/traces' },
  })),
  findConfigFile: jest.fn(),
}));

jest.mock('../governance/policy', () => ({
  ...jest.requireActual('../governance/policy'),
  checkAgentStatus: jest.fn(),
}));

type CheckBody = { action: { name: string }; context: { freshness?: unknown } };

describe('governance evidence scoping', () => {
  let post: jest.SpyInstance;

  beforeAll(() => {
    trace.setGlobalTracerProvider(new BasicTracerProvider());
  });

  afterAll(() => {
    trace.disable();
  });

  beforeEach(() => {
    _resetPepStateForTests();
    const client = axios.create();
    post = jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: { effect: 'allow', would_have: false, reasons: [] },
    });
    _setPepHttpClientForTests(client);
  });

  const readCustomer = observe({ name: 'read_customer', type: 'tool' })(
    async (args: { customer_id: string }) => ({ id: args.customer_id, as_of: '2026-10-14T10:00:00Z' }),
  );
  const updateCustomer = observe({ name: 'update_customer', type: 'tool' })(
    async (_args: { customer_id: string }) => ({ ok: true }),
  );

  function writeFreshness(): unknown[] {
    return post.mock.calls
      .map((call) => call[1] as CheckBody)
      .filter((body) => body.action.name === 'update_customer')
      .map((body) => body.context.freshness);
  }

  it('does not leak freshness to another agent or run', async () => {
    await govern({ agentId: 'agent-a', name: 'run_a' })(async () => readCustomer({ customer_id: 'cust-1' }))();
    await govern({ agentId: 'agent-b', name: 'run_b' })(async () => updateCustomer({ customer_id: 'cust-1' }))();
    await govern({ agentId: 'agent-a', name: 'run_a_again' })(async () =>
      updateCustomer({ customer_id: 'cust-1' }),
    )();

    expect(writeFreshness()).toEqual([undefined, undefined]);
  });

  it('keeps freshness within the same run for the same entity', async () => {
    await govern({ agentId: 'agent-a', name: 'run' })(async () => {
      await readCustomer({ customer_id: 'cust-1' });
      await updateCustomer({ customer_id: 'cust-1' });
      await updateCustomer({ customer_id: 'cust-2' });
    })();

    expect(writeFreshness()).toEqual([
      [{ tool: 'read_customer', read_at: '2026-10-14T10:00:00Z', field: 'as_of', resource_id: 'cust-1' }],
      undefined,
    ]);
  });

  it('keeps concurrent runs of different agents apart', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.all([
      govern({ agentId: 'agent-a', name: 'run_a' })(async () => {
        await readCustomer({ customer_id: 'cust-1' });
        await tick();
        await tick();
        await updateCustomer({ customer_id: 'cust-1' });
      })(),
      govern({ agentId: 'agent-b', name: 'run_b' })(async () => {
        await tick();
        await updateCustomer({ customer_id: 'cust-1' });
      })(),
    ]);

    const byAgent = Object.fromEntries(
      post.mock.calls
        .map((call) => call[1] as CheckBody & { agent_id: string })
        .filter((body) => body.action.name === 'update_customer')
        .map((body) => [body.agent_id, body.context.freshness]),
    );
    expect(byAgent['agent-a']).toEqual([expect.objectContaining({ tool: 'read_customer' })]);
    expect(byAgent['agent-b']).toBeUndefined();
  });

  it('keeps govern runs under one parent trace apart', async () => {
    const first = govern({ agentId: 'agent-a', name: 'first' })(async () => readCustomer({ customer_id: 'cust-1' }));
    const second = govern({ agentId: 'agent-a', name: 'second' })(async () =>
      updateCustomer({ customer_id: 'cust-1' }),
    );
    await observe({ name: 'request' })(async () => {
      await first();
      await second();
    })();

    expect(writeFreshness()).toEqual([undefined]);
  });

  it('keeps a nested govern call for another agent separate', async () => {
    const inner = govern({ agentId: 'agent-b', name: 'inner' })(async () => updateCustomer({ customer_id: 'cust-1' }));
    await govern({ agentId: 'agent-a', name: 'outer' })(async () => {
      await readCustomer({ customer_id: 'cust-1' });
      await inner();
    })();

    expect(writeFreshness()).toEqual([undefined]);
  });

  it('keeps tool-level reads when filtering customer-specific evidence', async () => {
    const getRefundPolicy = observe({ name: 'get_refund_policy', type: 'tool' })(async () => ({
      id: 'policy-v1',
      as_of: '2026-01-01T00:00:00Z',
    }));
    const readCustomerRecord = observe({ name: 'read_customer_record', type: 'tool' })(
      async (args: { customer_id: string }) => ({ customer_id: args.customer_id, as_of: '2026-10-14T10:00:00Z' }),
    );
    const issueRefund = observe({ name: 'issue_refund', type: 'tool' })(
      async (_args: { customer: { id: string }; amount: number }) => ({ ok: true }),
    );

    await govern({ agentId: 'agent-a', name: 'run' })(async () => {
      await getRefundPolicy();
      await readCustomerRecord({ customer_id: 'bob' });
      await issueRefund({ customer: { id: 'alice' }, amount: 10 });
    })();

    const refund = post.mock.calls
      .map((call) => call[1] as CheckBody)
      .find((body) => body.action.name === 'issue_refund');
    expect(refund?.context.freshness).toEqual([
      { tool: 'get_refund_policy', read_at: '2026-01-01T00:00:00Z', field: 'as_of' },
    ]);
  });

  it('drops evidence when the run ends', async () => {
    const retrieve = observe({ name: 'retrieve' })(async () => {
      getCurrentSpan()?.setAttribute('traccia.retrieval.chunk_count', 3);
    });
    const ragStep = observe({ name: 'rag_step' })(async () => {
      notePromptAttributes(getCurrentSpan()?.context?.traceId, { 'traccia.prompt.name': 'p' });
      await retrieve();
      await readCustomer({ customer_id: 'cust-1' });
      expect([retrievalByTrace.size, promptByTrace.size, lastReads.size]).toEqual([1, 1, 1]);
    });

    for (let i = 0; i < 50; i += 1) {
      await ragStep();
    }
    expect([retrievalByTrace.size, promptByTrace.size, lastReads.size]).toEqual([0, 0, 0]);
  });

  it('bounds the store by size and expiry', () => {
    const store = new EvidenceStore<number>(3, 60_000);
    for (let i = 0; i < 10; i += 1) {
      store.update(`t${i}`, `t${i}`, () => i);
    }
    expect(store.size).toBe(3);
    expect(store.get('t0')).toBeUndefined();
    expect(store.get('t9')).toBe(9);

    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect(store.get('t9')).toBeUndefined();
    jest.restoreAllMocks();
  });

  it('drops evidence on remote-root completion and isolates replayed traceparent headers in Express outside govern()', async () => {
    const middleware = expressMiddleware();
    const sharedTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const retrieve = observe({ name: 'retrieve' })(async () => {
      getCurrentSpan()?.setAttribute('traccia.retrieval.chunk_count', 7);
    });

    const makeReqRes = (remoteSpanId: string) => {
      const listeners: Record<string, Array<() => void>> = {};
      const req: any = {
        method: 'POST',
        url: '/chat',
        path: '/chat',
        headers: { traceparent: `00-${sharedTraceId}-${remoteSpanId}-01` },
      };
      const res: any = {
        statusCode: 200,
        on: (event: string, cb: () => void) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(cb);
        },
      };
      const finish = () => {
        for (const cb of listeners.finish || []) cb();
      };
      return { req, res, finish };
    };

    // Request A performs retrieval, prompt note, and freshness read, overlapping concurrently with Request B
    const { req: reqA, res: resA, finish: finishA } = makeReqRes('1111111111111111');
    const { req: reqB, res: resB, finish: finishB } = makeReqRes('1111111111111111');

    let finishReqA!: () => void;
    const reqAReady = new Promise<void>((resolve) => {
      finishReqA = resolve;
    });

    const runA = new Promise<void>((resolve, reject) => {
      middleware(reqA, resA, () => {
        void (async () => {
          await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
            await retrieve();
            notePromptAttributes(getCurrentSpan()?.context?.traceId, { 'traccia.prompt.name': 'rag-prompt' });
            await readCustomer({ customer_id: 'cust-1' });
            await reqAReady;
            await enforceLlmCall({ model: 'gpt-4o-mini' });
          });
        })().then(resolve, reject);
      });
    });

    // Wait one tick so A has stored its evidence and holds its local root open
    await new Promise((r) => setTimeout(r, 10));

    // Request B replays the exact same traceparent traceId, performs NO retrieval, and checks policy concurrently
    await new Promise<void>((resolve, reject) => {
      middleware(reqB, resB, () => {
        void (async () => {
          await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
            await enforceLlmCall({ model: 'gpt-4o-mini' });
            await updateCustomer({ customer_id: 'cust-1' });
          });
        })().then(resolve, reject);
      });
    });

    finishB();

    const llmChecksBeforeAFinishes = post.mock.calls
      .map((call) => call[1] as { action: { type: string }; context: { retrieval?: unknown; prompt?: unknown; freshness?: unknown } })
      .filter((body) => body.action.type === 'llm_call');
    expect(llmChecksBeforeAFinishes).toHaveLength(1);
    expect(llmChecksBeforeAFinishes[0].context.retrieval).toEqual({ present: false });
    expect(llmChecksBeforeAFinishes[0].context.prompt).toBeUndefined();

    const writeCheckB = post.mock.calls
      .map((call) => call[1] as CheckBody)
      .find((body) => body.action.name === 'update_customer');
    expect(writeCheckB?.context.freshness).toBeUndefined();

    // Now finish Request A: A still has its own evidence, and drops it on remote-root completion
    finishReqA();
    await runA;
    finishA();

    expect([retrievalByTrace.size, promptByTrace.size, lastReads.size]).toEqual([0, 0, 0]);

    const llmChecks = post.mock.calls
      .map((call) => call[1] as { action: { type: string }; context: { retrieval?: unknown; prompt?: unknown } })
      .filter((body) => body.action.type === 'llm_call');
    expect(llmChecks[1].context.retrieval).toEqual({ present: true, chunk_count: 7 });
    expect(llmChecks[1].context.prompt).toEqual({ name: 'rag-prompt' });

    // Sequential Request C replaying the same traceId also sees no stale retrieval
    const { req: reqC, res: resC, finish: finishC } = makeReqRes('2222222222222222');
    await new Promise<void>((resolve, reject) => {
      middleware(reqC, resC, () => {
        void (async () => {
          await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
            await enforceLlmCall({ model: 'gpt-4o-mini' });
          });
        })().then(resolve, reject);
      });
    });
    finishC();

    const thirdLlmCheck = post.mock.calls
      .map((call) => call[1] as { action: { type: string }; context: { retrieval?: unknown } })
      .filter((body) => body.action.type === 'llm_call')[2];
    expect(thirdLlmCheck.context.retrieval).toEqual({ present: false });
  });

  it('drops evidence on remote-root completion and isolates replayed traceparent headers in Fastify outside govern()', async () => {
    const hooks: Record<string, (req: any, reply: any, done: () => void) => void> = {};
    const mockFastify: any = {
      addHook: jest.fn((name: string, handler: (req: any, reply: any, done: () => void) => void) => {
        hooks[name] = handler;
      }),
    };
    const plugin = fastifyPlugin();
    plugin(mockFastify, {}, () => {});

    const sharedTraceId = '778899aabbccddeeff00112233445566';
    const retrieve = observe({ name: 'retrieve' })(async () => {
      getCurrentSpan()?.setAttribute('traccia.retrieval.chunk_count', 7);
    });

    const reqA: any = {
      method: 'POST',
      url: '/fastify-chat',
      headers: { traceparent: `00-${sharedTraceId}-aaaaaaaaaaaaaaaa-01` },
    };
    await new Promise<void>((resolve, reject) => {
      hooks.onRequest(reqA, {}, () => {
        void (async () => {
          await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
            await retrieve();
            notePromptAttributes(getCurrentSpan()?.context?.traceId, { 'traccia.prompt.name': 'fastify-prompt' });
            await readCustomer({ customer_id: 'cust-1' });
          });
        })().then(resolve, reject);
      });
    });
    hooks.onResponse(reqA, { statusCode: 200 }, () => {});
    expect([retrievalByTrace.size, promptByTrace.size, lastReads.size]).toEqual([0, 0, 0]);

    const reqB: any = {
      method: 'POST',
      url: '/fastify-chat',
      headers: { traceparent: `00-${sharedTraceId}-aaaaaaaaaaaaaaaa-01` },
    };
    await new Promise<void>((resolve, reject) => {
      hooks.onRequest(reqB, {}, () => {
        void (async () => {
          await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
            await enforceLlmCall({ model: 'gpt-4o-mini' });
            await updateCustomer({ customer_id: 'cust-1' });
          });
        })().then(resolve, reject);
      });
    });
    hooks.onResponse(reqB, { statusCode: 200 }, () => {});

    const llmBody = post.mock.calls
      .map((call) => call[1] as { action: { type: string }; context: { retrieval?: unknown; prompt?: unknown } })
      .find((body) => body.action.type === 'llm_call');
    expect(llmBody?.context.retrieval).toEqual({ present: false });
    expect(llmBody?.context.prompt).toBeUndefined();

    const writeBody = post.mock.calls
      .map((call) => call[1] as CheckBody)
      .find((body) => body.action.name === 'update_customer');
    expect(writeBody?.context.freshness).toBeUndefined();
  });
});
