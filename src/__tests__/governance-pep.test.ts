import axios from 'axios';
import { shouldSkipHttp } from '../instrumentation/http-skip';
import { AgentBlockedError } from '../governance/policy';
import {
  checkPolicy,
  enforceLlmCall,
  enforceToolCall,
  noteRetrievalAttributes,
  rememberToolResult,
  settlePolicy,
  _asOtelHexForTests,
  _setPepHttpClientForTests,
  _resetPepStateForTests,
} from '../governance/pep';
import { runIdentity } from '../config/runtime-config';
import * as spanContext from '../context/context';

jest.mock('../config/config', () => ({
  loadConfig: jest.fn(() => ({
    tracing: {
      api_key: 'test-key',
      endpoint: 'https://app.traccia.ai/v1/traces',
    },
  })),
  findConfigFile: jest.fn(),
}));

describe('governance pep', () => {
  beforeEach(() => {
    _resetPepStateForTests();
    jest.clearAllMocks();
  });

  it('skips policy check and settle URLs', () => {
    expect(shouldSkipHttp('https://app.traccia.ai/api/v1/policy/check')).toBe(true);
    expect(shouldSkipHttp('http://localhost:8001/api/v1/policy/settle')).toBe(true);
  });

  it('does not check when pep is off', async () => {
    const kwargs = { model: 'gpt-4o' };
    await expect(enforceLlmCall(kwargs)).resolves.toBeUndefined();
    expect(kwargs.model).toBe('gpt-4o');
  });

  it('raises a readable AgentBlockedError on deny', async () => {
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: {
        id: 'dec-1',
        effect: 'deny',
        would_have: false,
        reasons: ['spend exceeded cap'],
        remaining_budget_usd: 0.0,
        obligations: {},
      },
    });
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      await expect(checkPolicy({ action: { type: 'llm_call', model: 'gpt-4o' } })).rejects.toEqual(
        expect.objectContaining({
          name: 'AgentBlockedError',
          decisionId: 'dec-1',
          remainingBudgetUsd: 0,
          message: expect.stringContaining('spend exceeded cap'),
        }),
      );
    });
    expect(post).toHaveBeenCalled();
  });

  it('swaps the model on reshape', async () => {
    const client = axios.create();
    jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: {
        id: 'dec-2',
        effect: 'reshape',
        would_have: false,
        reasons: ['use cheaper model'],
        obligations: { cheaper_model: 'gpt-4o-mini' },
        remaining_budget_usd: 1.0,
      },
    });
    _setPepHttpClientForTests(client);

    const kwargs = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      const out = await enforceLlmCall(kwargs);
      expect(out?.effect).toBe('reshape');
      expect(kwargs.model).toBe('gpt-4o-mini');
    });
  });

  it('proceeds when would_have is true', async () => {
    const client = axios.create();
    jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: {
        id: 'dec-3',
        effect: 'deny',
        would_have: true,
        reasons: ['would deny'],
        obligations: {},
      },
    });
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      const out = await checkPolicy({ action: { type: 'llm_call' } });
      expect(out.would_have).toBe(true);
    });
  });

  it('sends a tool_call action for tools', async () => {
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: { id: 'dec-4', effect: 'allow', would_have: false, reasons: [] },
    });
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      const out = await enforceToolCall('search', { q: 'x' });
      expect(out?.effect).toBe('allow');
    });
    expect(post.mock.calls[0][1]).toMatchObject({
      action: { type: 'tool_call', name: 'search' },
      context: { input: { q: 'x' }, tool_name: 'search' },
    });
  });

  it('raises AgentBlockedError on a refund amount deny', async () => {
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: {
        id: 'dec-refund',
        effect: 'deny',
        would_have: false,
        reasons: ['Refund Guard amount $80.000 is above $50.000'],
        obligations: {},
      },
    });
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      await expect(enforceToolCall('issue_refund', { amount: 80 })).rejects.toEqual(
        expect.objectContaining({
          name: 'AgentBlockedError',
          decisionId: 'dec-refund',
          message: expect.stringContaining('above'),
        }),
      );
    });
    expect(post.mock.calls[0][1]).toMatchObject({
      action: { type: 'tool_call', name: 'issue_refund' },
      context: { input: { amount: 80 }, tool_name: 'issue_refund' },
    });
  });

  it('raises AgentBlockedError on a high-risk tool name deny', async () => {
    const client = axios.create();
    jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: {
        id: 'dec-risk',
        effect: 'deny',
        would_have: false,
        reasons: ['High-Risk Tool delete_account is not allowed unsupervised'],
        obligations: {},
      },
    });
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      await expect(enforceToolCall('delete_account', {})).rejects.toEqual(
        expect.objectContaining({
          name: 'AgentBlockedError',
          message: expect.stringContaining('delete_account'),
        }),
      );
    });
  });

  it('raises AgentBlockedError on a dangerous shell pattern deny', async () => {
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: {
        id: 'dec-shell',
        effect: 'deny',
        would_have: false,
        reasons: ['Dangerous Shell Commands matched rm -rf'],
        obligations: {},
      },
    });
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      await expect(enforceToolCall('shell', { command: 'rm -rf /' })).rejects.toEqual(
        expect.objectContaining({
          name: 'AgentBlockedError',
          message: expect.stringContaining('rm -rf'),
        }),
      );
    });
    expect(post.mock.calls[0][1]).toMatchObject({
      action: { type: 'tool_call', name: 'shell' },
      context: { input: { command: 'rm -rf /' }, tool_name: 'shell' },
    });
  });

  it('does not treat a deny as a thrown AgentBlockedError when HTTP fails', async () => {
    const client = axios.create();
    jest.spyOn(client, 'post').mockRejectedValue(new Error('timeout'));
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      const out = await checkPolicy({ action: { type: 'llm_call' } });
      expect(out.effect).toBe('allow');
      expect(out.reasons).toEqual(['check_error']);
    });
  });

  it('maps HTTP error responses to check_http_error', async () => {
    const client = axios.create();
    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 503 },
    });
    jest.spyOn(client, 'post').mockRejectedValue(err);
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      const out = await checkPolicy({ action: { type: 'llm_call' } });
      expect(out.reasons).toEqual(['check_http_error']);
    });
  });

  it('formats integer trace ids as padded hex', () => {
    expect(_asOtelHexForTests(1, 32)).toBe(`${'0'.repeat(31)}1`);
    expect(_asOtelHexForTests('abc', 32)).toBe('abc');
    expect(_asOtelHexForTests(null, 32)).toBeUndefined();
  });

  it('includes trace_id on settle, matching Python', async () => {
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({ status: 200, data: {} });
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      await settlePolicy(
        { obligations: { reserved_usd: 0.25 } },
        { actualUsd: 0.1 },
      );
    });
    expect(post.mock.calls[0][1]).toMatchObject({
      agent_id: 'support',
      reserved_usd: 0.25,
      actual_usd: 0.1,
    });
    expect(post.mock.calls[0][1]).toHaveProperty('trace_id');
  });

  it('sends the last read timestamp and customer id on a write check', async () => {
    rememberToolResult('search', { q: 'x' });
    rememberToolResult('get_refund_policy', { as_of: '2026-09-24T11:40:00Z', text: 'policy' });
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: { id: 'dec-fresh', effect: 'allow', would_have: false, reasons: [] },
    });
    _setPepHttpClientForTests(client);
    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      await enforceToolCall('issue_refund', { amount: 10, customer: { id: 'alice' } });
    });
    const body = post.mock.calls[0][1] as { context: { freshness: unknown[]; customer_id: string } };
    expect(body.context.freshness).toEqual(
      expect.arrayContaining([
        { tool: 'get_refund_policy', read_at: '2026-09-24T11:40:00Z', field: 'as_of' },
      ]),
    );
    expect(body.context.customer_id).toBe('alice');
  });

  it('sends prompt pin fields and a real retrieval count on the LLM check', async () => {
    noteRetrievalAttributes('abc', { 'traccia.retrieval.chunk_count': 4 });
    jest.spyOn(spanContext, 'getCurrentSpan').mockReturnValue({
      context: { traceId: 'abc', spanId: 'def', traceFlags: 1 },
      attributes: {
        'traccia.prompt.name': 'refund-policy',
        'traccia.prompt.label': 'production',
        'traccia.prompt.version_id': 'ver-1',
      },
      setAttribute: jest.fn(),
    } as never);
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: { id: 'dec-pin', effect: 'allow', would_have: false, reasons: [] },
    });
    _setPepHttpClientForTests(client);
    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      await enforceLlmCall({ model: 'gpt-4o-mini' });
    });
    const body = post.mock.calls[0][1] as {
      context: { prompt: Record<string, string>; retrieval: { present: boolean; chunk_count?: number } };
    };
    expect(body.context.prompt).toEqual({
      name: 'refund-policy',
      label: 'production',
      version_id: 'ver-1',
    });
    expect(body.context.retrieval.present).toBe(true);
    expect(body.context.retrieval.chunk_count).toBe(4);
  });

  it('omits prompt fields and does not invent a chunk count', async () => {
    jest.spyOn(spanContext, 'getCurrentSpan').mockReturnValue({
      context: { traceId: 'plain', spanId: 'span', traceFlags: 1 },
      attributes: {},
      setAttribute: jest.fn(),
    } as never);
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: { id: 'dec-plain', effect: 'allow', would_have: false, reasons: [] },
    });
    _setPepHttpClientForTests(client);
    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      await enforceLlmCall({ model: 'gpt-4o-mini' });
    });
    const body = post.mock.calls[0][1] as { context: Record<string, unknown> };
    expect(body.context.prompt).toBeUndefined();
    expect(body.context.retrieval).toEqual({ present: false });
  });
});

describe('AgentBlockedError extras', () => {
  it('carries decision id, remaining budget, and reasons', () => {
    const err = new AgentBlockedError('spend exceeded cap. remaining budget $0.00. decision dec-1', {
      decisionId: 'dec-1',
      remainingBudgetUsd: 0,
      reasons: ['spend exceeded cap'],
    });
    expect(err.decisionId).toBe('dec-1');
    expect(err.remainingBudgetUsd).toBe(0);
    expect(err.reasons).toEqual(['spend exceeded cap']);
  });
});
