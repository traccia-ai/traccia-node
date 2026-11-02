/**
 * TRC-289: freshness evidence must not cross agent/run boundaries, and per-trace
 * evidence must not outlive its run.
 */
import axios from 'axios';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { observe } from '../instrumentation/decorator';
import { govern } from '../governance/govern';
import { getCurrentSpan } from '../context/context';
import { _resetPepStateForTests, _setPepHttpClientForTests, notePromptAttributes } from '../governance/pep';
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
});
