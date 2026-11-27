import { createHmac } from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { shouldSkipHttp } from '../instrumentation/http-skip';
import { observe, ObserveOptions } from '../instrumentation/decorator';
import { coerceKeyTypes, DefiniteFailure, deriveKey, idempotencyKey, Unkeyable } from '../governance/idempotency';
import { AgentBlockedError, ApprovalPending, GovernanceConfigError, IdempotencyRepeatError, pendingToolResult } from '../governance/policy';
import {
  checkPolicy,
  enforceLlmCall,
  enforceToolCall,
  jitteredDelay,
  noteRetrievalAttributes,
  rememberToolResult,
  reservedUsd,
  estimateTokens,
  IMAGE_PROMPT_CHARS,
  trackPendingSettle,
  flushPendingSettles,
  settlePolicy,
  _asOtelHexForTests,
  _setPepHttpClientForTests,
  _resetPepStateForTests,
  _setInFlightClockForTests,
} from '../governance/pep';
import { runIdentity } from '../config/runtime-config';
import { clearClientConfig, setClientConfig } from '../config/client-config';
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

  it.each([
    ['responses', { max_output_tokens: 100 }, 'openai', 'responses', 100, { max_output_tokens: 5 }],
    ['chat max_completion_tokens', { max_completion_tokens: 100 }, 'openai', undefined, 100, { max_completion_tokens: 5 }],
    ['chat max_tokens', { max_tokens: 100 }, 'openai', undefined, 100, { max_tokens: 5 }],
    ['openai chat without a cap', {}, 'openai', undefined, undefined, { max_completion_tokens: 5 }],
    ['anthropic', { max_tokens: 100 }, 'anthropic', undefined, 100, { max_tokens: 5 }],
    ['groq max_completion_tokens', { max_completion_tokens: 100 }, 'groq', undefined, 100, { max_completion_tokens: 5 }],
    ['groq max_tokens', { max_tokens: 100 }, 'groq', undefined, 100, { max_tokens: 5 }],
    ['groq without a cap', {}, 'groq', undefined, undefined, { max_tokens: 5 }],
    [
      'gemini',
      { generation_config: { max_output_tokens: 100, temperature: 0.2 } },
      'google_gemini',
      undefined,
      100,
      { generation_config: { max_output_tokens: 5, temperature: 0.2 } },
    ],
  ])('clamps the %s token cap', async (_name, cap, vendor, api, sentCap, clamped) => {
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: { id: 'dec-c', effect: 'reshape', would_have: false, obligations: { clamp_max_tokens: 5 } },
    });
    _setPepHttpClientForTests(client);

    const kwargs: Record<string, unknown> = { model: 'm', ...cap };
    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      await enforceLlmCall(kwargs, vendor, api);
    });
    expect((post.mock.calls[0][1] as { context: { max_tokens?: number } }).context.max_tokens).toBe(sentCap);
    expect(kwargs).toEqual({ model: 'm', ...clamped });
  });

  it('sends the vendor so Spend Cap prices the right provider', async () => {
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: { id: 'dec-v', effect: 'allow', would_have: false, obligations: {} },
    });
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      await enforceLlmCall({ model: 'gemini-2.0-flash-001' }, 'google_gemini');
    });
    const body = post.mock.calls[0][1] as { context: Record<string, unknown> };
    expect(body.context.vendor).toBe('google_gemini');
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

  it('raises ApprovalPending on a held refund and not AgentBlockedError', async () => {
    const client = axios.create();
    jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: {
        id: 'dec-queue',
        effect: 'queue',
        would_have: false,
        approval_id: 'appr-1',
        approval_expires_at: '2026-10-06T00:15:00+00:00',
        reasons: ['needs approval'],
      },
    });
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      try {
        await enforceToolCall('issue_refund', { amount: 40 });
        throw new Error('expected ApprovalPending');
      } catch (err) {
        expect(err).toBeInstanceOf(ApprovalPending);
        expect(err).not.toBeInstanceOf(AgentBlockedError);
        expect(pendingToolResult(err as ApprovalPending)).toEqual({
          status: 'pending_approval',
          approval_id: 'appr-1',
          expires_at: '2026-10-06T00:15:00+00:00',
        });
      }
    });
  });

  it('returns a would-have queue without throwing', async () => {
    const client = axios.create();
    jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: { id: 'dec-wh', effect: 'queue', would_have: true, reasons: ['needs approval'] },
    });
    _setPepHttpClientForTests(client);
    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      const out = await enforceToolCall('issue_refund', { amount: 40 });
      expect(out?.would_have).toBe(true);
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

  it('blocks by default when the check fails', async () => {
    const client = axios.create();
    jest.spyOn(client, 'post').mockRejectedValue(new Error('timeout'));
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      const err = await checkPolicy({ action: { type: 'llm_call' } }).catch((e) => e);
      expect(err).toBeInstanceOf(AgentBlockedError);
      expect(err.reasons).toEqual(['check_error']);
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
      const err = await checkPolicy({ action: { type: 'llm_call' } }).catch((e) => e);
      expect(err.reasons).toEqual(['check_http_error']);
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

  it('settles a decision with the credentials and agent its check used', async () => {
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: { id: 'dec-r', effect: 'allow', would_have: false, obligations: { reserved_usd: 0.25 } },
    });
    _setPepHttpClientForTests(client);
    setClientConfig('init-key', 'http://127.0.0.1:9/v1/traces');
    try {
      const decision = await runIdentity({ agentId: 'support', pepEnabled: true }, () =>
        checkPolicy({ action: { type: 'llm_call', model: 'gpt-4o' } }),
      );
      // stopTracing() cleared the init() credentials; another agent is current.
      clearClientConfig();
      await runIdentity({ agentId: 'other' }, () => settlePolicy(decision, { actualUsd: 0.1 }));
    } finally {
      clearClientConfig();
    }
    expect(post).toHaveBeenCalledTimes(2);
    const [url, body, options] = post.mock.calls[1] as [string, Record<string, unknown>, { headers: Record<string, string> }];
    expect(url).toBe('http://127.0.0.1:9/api/v1/policy/settle');
    expect(body).toMatchObject({ agent_id: 'support', reserved_usd: 0.25, actual_usd: 0.1 });
    expect(options.headers.Authorization).toBe('Bearer init-key');
  });

  it('still settles a decision it did not check with the current credentials', async () => {
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({ status: 200, data: {} });
    _setPepHttpClientForTests(client);
    await runIdentity({ agentId: 'support' }, () => settlePolicy({ obligations: { reserved_usd: 0.25 } }));
    expect(post.mock.calls[0][0]).toBe('https://app.traccia.ai/api/v1/policy/settle');
    expect((post.mock.calls[0][2] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer test-key');
  });

  it('sends model, vendor and token counts on settle for the server to price', async () => {
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({ status: 200, data: {} });
    _setPepHttpClientForTests(client);

    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      await settlePolicy(
        { obligations: { reserved_usd: 0.25 } },
        { model: 'llama-3.3-70b-versatile', vendor: 'groq', inputTokens: 11, outputTokens: 5 },
      );
    });
    expect(post.mock.calls[0][1]).toMatchObject({
      reserved_usd: 0.25,
      release: false,
      model: 'llama-3.3-70b-versatile',
      vendor: 'groq',
      input_tokens: 11,
      output_tokens: 5,
    });
    expect(post.mock.calls[0][1]).toHaveProperty('actual_usd', undefined);
  });

  describe('estimateTokens', () => {
    it('counts string content as before', () => {
      // 'Be brief.' + newline + 'Capital of France?' is 28 characters.
      expect(
        estimateTokens({
          messages: [
            { role: 'system', content: 'Be brief.' },
            { role: 'user', content: 'Capital of France?' },
          ],
        })
      ).toBe(7);
      expect(estimateTokens({ prompt: 'x'.repeat(40) })).toBe(10);
      expect(estimateTokens({ messages: [{ role: 'user', content: null }] })).toBeUndefined();
    });

    it('counts the text of content parts, not "[object Object]"', () => {
      const text = 'x'.repeat(40000);
      expect(estimateTokens({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] })).toBe(10000);
    });

    it('counts each image part at a fixed allowance, whatever its URL size', () => {
      const content = [
        { type: 'text', text: 'What is in these images?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(500000) } },
        { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
      ];
      expect(estimateTokens({ messages: [{ role: 'user', content }] })).toBe(
        Math.floor((24 + 2 * IMAGE_PROMPT_CHARS) / 4)
      );
    });

    it('counts tool call arguments sent back in the conversation', () => {
      const args = 'y'.repeat(400);
      expect(
        estimateTokens({
          messages: [{ role: 'assistant', content: null, tool_calls: [{ function: { name: 'f', arguments: args } }] }],
        })
      ).toBe(100);
    });
  });

  it('flushPendingSettles waits for background settles, and returns at once with none', async () => {
    await expect(flushPendingSettles()).resolves.toBeUndefined();
    let finish: () => void = () => undefined;
    trackPendingSettle(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    let flushed = false;
    const flushing = flushPendingSettles().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);
    finish();
    await flushing;
    expect(flushed).toBe(true);
  });

  it('reports the reserved amount of a decision', () => {
    expect(reservedUsd({ obligations: { reserved_usd: 0.25 } })).toBe(0.25);
    expect(reservedUsd({ obligations: {} })).toBeUndefined();
    expect(reservedUsd(undefined)).toBeUndefined();
  });

  it('sends the last read timestamp and customer id on a write check', async () => {
    jest.spyOn(spanContext, 'getCurrentSpan').mockReturnValue({
      context: { traceId: 'run-1', spanId: 'span-1', traceFlags: 1 },
      attributes: {},
      setAttribute: jest.fn(),
    } as never);
    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      rememberToolResult('search', { q: 'x' });
      rememberToolResult('get_refund_policy', { as_of: '2026-09-24T11:40:00Z', text: 'policy' });
    });
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

  it('sends the vendor on the LLM check only when given', async () => {
    const client = axios.create();
    const post = jest.spyOn(client, 'post').mockResolvedValue({
      status: 200,
      data: { id: 'dec-vendor', effect: 'allow', would_have: false, reasons: [] },
    });
    _setPepHttpClientForTests(client);
    await runIdentity({ agentId: 'support', pepEnabled: true }, async () => {
      await enforceLlmCall({ model: 'llama-3.3-70b-versatile' }, 'groq');
      await enforceLlmCall({ model: 'gpt-4o-mini' });
    });
    const contexts = post.mock.calls.map((call) => (call[1] as { context: Record<string, unknown> }).context);
    expect(contexts[0].vendor).toBe('groq');
    expect(contexts[1]).not.toHaveProperty('vendor');
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

  describe('fail-closed runs', () => {
    const failClosed = { agentId: 'support', pepEnabled: true, pepFailMode: 'closed' as const };

    it('blocks on a transport error', async () => {
      const client = axios.create();
      jest.spyOn(client, 'post').mockRejectedValue(new Error('timeout'));
      _setPepHttpClientForTests(client);

      await runIdentity(failClosed, async () => {
        const err = await enforceLlmCall({ model: 'gpt-4o' }).catch((e) => e);
        expect(err).toBeInstanceOf(AgentBlockedError);
        expect(err.reasons).toEqual(['check_error']);
        expect(err.message).toContain('policy fail mode is closed');
      });
    });

    it('blocks on an HTTP error response', async () => {
      const client = axios.create();
      const httpErr = Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: { status: 503 },
      });
      jest.spyOn(client, 'post').mockRejectedValue(httpErr);
      _setPepHttpClientForTests(client);

      await runIdentity(failClosed, async () => {
        const err = await enforceToolCall('issue_refund', { amount: 80 }).catch((e) => e);
        expect(err).toBeInstanceOf(AgentBlockedError);
        expect(err.reasons).toEqual(['check_http_error']);
      });
    });

    it('blocks when credentials are missing', async () => {
      const { loadConfig } = jest.requireMock('../config/config') as { loadConfig: jest.Mock };
      loadConfig.mockReturnValueOnce({ tracing: {} });
      const saved = { key: process.env.TRACCIA_API_KEY, endpoint: process.env.TRACCIA_ENDPOINT };
      delete process.env.TRACCIA_API_KEY;
      delete process.env.TRACCIA_ENDPOINT;
      try {
        await runIdentity(failClosed, async () => {
          const err = await enforceToolCall('search', { q: 'x' }).catch((e) => e);
          expect(err).toBeInstanceOf(GovernanceConfigError);
        });
      } finally {
        if (saved.key !== undefined) process.env.TRACCIA_API_KEY = saved.key;
        if (saved.endpoint !== undefined) process.env.TRACCIA_ENDPOINT = saved.endpoint;
      }
    });

    it('still passes a real allow decision', async () => {
      const client = axios.create();
      jest.spyOn(client, 'post').mockResolvedValue({
        status: 200,
        data: { id: 'dec-ok', effect: 'allow', would_have: false, reasons: [] },
      });
      _setPepHttpClientForTests(client);

      await runIdentity(failClosed, async () => {
        const out = await enforceToolCall('search', { q: 'x' });
        expect(out?.id).toBe('dec-ok');
      });
    });
  });
});

// Idempotent tool lifecycle (check -> run -> settle). The table names mirror the Python SDK's
// tests/test_governance_pep.py.

const IDEM_TOKEN = '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d';
// Python: derive_key('a1', 'issue_refund', {'order_id': 'o1', 'amount': '5'})
const PY_REFUND_KEY = 'idk1_33a9929e50ce1c04b5aa3a93c782d9168a1478f91c126ec4c1ef988879c5c3fe';
// Python: HMAC-SHA256('test-key', PY_REFUND_KEY), computed with Python's hmac module
const PY_REFUND_FALLBACK_KEY = 'idk1_5719b8838a8559e7f35c099b72784056c52c4fc7cd82db008614b9d68c7421f3';
const DOWNSTREAM = 'idk1_' + 'b'.repeat(64);
const OBLIGATION = { key: 'idk1_' + '0'.repeat(64), token: IDEM_TOKEN, window_s: 60 };

/** What the dashboard adds when a Block idempotency policy's own deny stopped the call. */
function idemDenied(reasons: string[]): Record<string, string> {
  const reason = reasons.find((r) => r.startsWith('idempotency_') && !r.includes('unkeyable'));
  return reason ? { idempotency_denied: reason } : {};
}

/** What a tool passes downstream with no per-attempt key: the call key keyed by the test API key. */
function keyed(callKey: string): string {
  return 'idk1_' + createHmac('sha256', 'test-key').update(callKey).digest('hex');
}

/** A reply; `raw` resolves a non-2xx as is, as axios does with validateStatus turned off. */
type Reply = { status: number; data?: unknown; raw?: boolean };

function httpError(status: number, data?: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });
}

/** A check deny; by default with the idempotency_denied a Block idempotency policy adds. */
function denyReply(reasons: string[], obligations: Record<string, unknown> = idemDenied(reasons)): Reply {
  return { status: 200, data: { id: 'dec-deny', effect: 'deny', would_have: false, reasons, obligations } };
}

/**
 * Checks answer with an idempotency reservation; settles are recorded and answered, with axios
 * semantics (a non-2xx rejects).
 */
class IdemServer {
  checks: Array<Record<string, any>> = [];
  settles: Array<Record<string, any>> = [];
  check?: Reply | Error; // the answer to every check
  checkScript: Reply[] = []; // answers for the next checks, before the normal reservation
  settleScript: Array<Reply | Error> = []; // answers for the next settles, before { ok: true }
  downstreamKey?: unknown; // the per-attempt key a newer dashboard hands back

  client(): AxiosInstance {
    return {
      post: async (url: string, body: Record<string, any>) => {
        if (url.endsWith('/check')) {
          this.checks.push(body);
          if (this.check instanceof Error) throw this.check;
          if (this.check) return this.check;
          if (this.checkScript.length) return this.checkScript.shift()!;
          const obligations: Record<string, unknown> = {};
          const idem = body.context?.idempotency || {};
          if (idem.key) obligations.idempotency = { key: idem.key, token: IDEM_TOKEN, window_s: 3600 };
          if (this.downstreamKey !== undefined) obligations.idempotency_downstream_key = this.downstreamKey;
          return { status: 200, data: { id: 'dec-idem', effect: 'allow', would_have: false, reasons: [], obligations } };
        }
        this.settles.push(body);
        const reply = this.settleScript.shift() ?? { status: 200, data: { ok: true } };
        if (reply instanceof Error) throw reply;
        if (!reply.raw && (reply.status < 200 || reply.status >= 300)) throw httpError(reply.status, reply.data);
        return { status: reply.status, data: reply.data };
      },
    } as unknown as AxiosInstance;
  }

  /** The client, with each body serialized first, as axios does with JSON.stringify before any I/O. */
  wireClient(): AxiosInstance {
    const inner = this.client();
    return {
      post: (url: string, body: unknown) => inner.post(url, JSON.parse(JSON.stringify(body))),
    } as unknown as AxiosInstance;
  }

  outcomes(): string[] {
    return this.settles.map((s) => s.idempotency.outcome);
  }
}

/** An idempotent tool named `name`; the wrapper always returns a promise. */
function idemTool<A extends unknown[], R>(
  name: string,
  fn: (this: any, ...args: A) => R,
  opts: Partial<ObserveOptions> = {},
): (this: any, ...args: A) => Promise<Awaited<R>> {
  return observe({ name, asType: 'tool', idempotent: true, ...opts })(fn);
}

function currentSpanAttributes(): Record<string, unknown> {
  return spanContext.getCurrentSpan()!.attributes as Record<string, unknown>;
}

/** Fakes the current span; returns its setAttribute mock. */
function fakeSpan(): jest.Mock {
  const setAttribute = jest.fn();
  jest.spyOn(spanContext, 'getCurrentSpan').mockReturnValue({
    context: { traceId: 't', spanId: 's', traceFlags: 1 },
    attributes: {},
    setAttribute,
  } as never);
  return setAttribute;
}

/** In-flight waits on a fake clock: sleeping only advances it, and jitter is off. */
function fakeClock(): { slept: number[] } {
  const clock = { now: 0, slept: [] as number[] };
  _setInFlightClockForTests(
    () => clock.now,
    async (ms: number) => {
      clock.slept.push(ms);
      clock.now += ms;
    },
  );
  return clock;
}

/** Runs `fn` with these environment variables removed, then puts them back. */
async function withoutEnv(names: string[], fn: () => unknown): Promise<void> {
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    await fn();
  } finally {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
}

/** An error with Node's `code` (or a DOMException-style `name`). */
function netError(props: { name?: string; code?: string }): Error {
  const error = new Error(props.code || props.name || 'error');
  if (props.name) error.name = props.name;
  if (props.code) (error as Error & { code?: string }).code = props.code;
  return error;
}

describe('idempotent tools', () => {
  let server: IdemServer;
  let warn: jest.SpyInstance;
  const on = { agentId: 'a1', pepEnabled: true };
  const off = { agentId: 'a1', pepEnabled: false };

  beforeEach(() => {
    jest.spyOn(spanContext, 'getCurrentSpan').mockRestore(); // earlier tests fake the span
    _resetPepStateForTests();
    server = new IdemServer();
    _setPepHttpClientForTests(server.client());
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  describe('lifecycle', () => {
    it('checks, binds the downstream key across awaits, and commits', async () => {
      const seen: { key?: string; attrs?: Record<string, unknown> } = {};
      const sendEmail = idemTool(
        'send_email',
        async (_args: { to: string; body: string }) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          seen.key = idempotencyKey();
          seen.attrs = currentSpanAttributes();
          return { sent: true };
        },
        { keyFields: ['to'] },
      );
      await runIdentity(on, async () => {
        expect(await sendEmail({ to: 'x@y.z', body: 'hello' })).toEqual({ sent: true });
      });
      expect(server.checks).toHaveLength(1);
      const [check] = server.checks;
      // agent scope by default: no idempotency_scope is sent
      expect(check.action).toEqual({ type: 'tool_call', name: 'send_email', idempotent: true });
      const key = check.context.idempotency.key;
      expect(key).toBe(deriveKey('a1', 'send_email', { to: 'x@y.z' }));
      expect(seen.key).toBe(keyed(key));
      expect(server.settles).toHaveLength(1);
      const [settle] = server.settles;
      // settles name the call key; the tool got the keyed one
      expect(settle.idempotency).toEqual({ key, token: IDEM_TOKEN, window_s: 3600, outcome: 'commit' });
      expect(settle.agent_id).toBe('a1');
      expect(settle.release).toBe(false);
      expect(settle).not.toHaveProperty('reserved_usd');
      expect(JSON.stringify(settle)).not.toContain('hello');
      expect(seen.attrs!['traccia.idempotency.key']).toBeUndefined(); // the call key never goes on a span
      expect(seen.attrs!['traccia.idempotency.downstream_key']).toBe(keyed(key));
      expect(seen.attrs!['traccia.idempotency.settle_failed']).toBeUndefined();
    });

    it('keys a single-object call and its fallback downstream key like the Python SDK', async () => {
      const refund = idemTool('issue_refund', (_args: { order_id: string; amount: string }) => idempotencyKey());
      const key = await runIdentity(off, () => refund({ order_id: 'o1', amount: '5' }));
      expect(key).toBe(PY_REFUND_FALLBACK_KEY);
      expect(key).toBe(keyed(PY_REFUND_KEY));
    });

    it('binds the key without a check or settle when the PEP is disabled', async () => {
      const sendEmail = idemTool('send_email', (_args: { to: string }) => idempotencyKey());
      const key = await runIdentity(off, () => sendEmail({ to: 'x@y.z' }));
      expect(key).toBe(keyed(deriveKey('a1', 'send_email', { to: 'x@y.z' })));
      expect(key).toHaveLength(69);
      expect(server.checks).toEqual([]);
      expect(server.settles).toEqual([]);
    });

    it('binds the key when the dashboard is unreachable and the fail mode is open', async () => {
      server.check = new Error('connect ECONNREFUSED');
      const sendEmail = idemTool('send_email', (_args: { to: string }) => idempotencyKey());
      const key = await runIdentity({ ...on, pepFailMode: 'open' }, () => sendEmail({ to: 'x@y.z' }));
      expect(key).toMatch(/^idk1_[0-9a-f]{64}$/);
      expect(server.checks).toHaveLength(1);
      expect(server.settles).toEqual([]);
    });

    it('leaves non-idempotent tools unchanged', async () => {
      const search = observe({ name: 'search', asType: 'tool' })((_args: { q: string }) => {
        expect(() => idempotencyKey()).toThrow('outside an idempotent tool');
        return 'r';
      });
      await runIdentity(on, async () => {
        expect(await search({ q: 'x' })).toBe('r');
      });
      expect(server.checks).toHaveLength(1);
      const [check] = server.checks;
      expect(check.action).toEqual({ type: 'tool_call', name: 'search' });
      expect(check.context).not.toHaveProperty('idempotency');
      expect(check.context.input).toEqual({ q: 'x' });
      expect(server.settles).toEqual([]);
    });

    it('wraps a method decorated the TypeScript 5 (TC39) way', async () => {
      const method = async function (this: unknown, _args: { order_id: string }) {
        return idempotencyKey();
      };
      // What TypeScript 5 emits without experimentalDecorators: decorator(method, context).
      const wrapped = (observe({ name: 'refund', asType: 'tool', idempotent: true }) as unknown as (
        fn: typeof method,
        ctx: { kind: string; name: string },
      ) => typeof method)(method, { kind: 'method', name: 'refund' });
      expect(wrapped).not.toBe(method);
      const key = await runIdentity(on, () => wrapped.call({}, { order_id: 'o1' }));
      expect(key).toMatch(/^idk1_/);
      expect(server.checks).toHaveLength(1);
      expect(server.outcomes()).toEqual(['commit']);
    });
  });

  describe('settleByOutcome', () => {
    class ProviderUnavailable extends Error {}
    // [label, options, sync throw?, error, outcome]
    test.each<[string, Partial<ObserveOptions>, boolean, unknown, string]>([
      ['a sync DefiniteFailure releases', {}, true, new DefiniteFailure('card declined'), 'release'],
      ['an async DefiniteFailure releases', {}, false, new DefiniteFailure('card declined'), 'release'],
      // anything not known to be definite is held, the tool's own errors included
      ['a sync throw is unconfirmed', {}, true, new RangeError('card declined'), 'unconfirmed'],
      ['a thrown string is unconfirmed', {}, false, 'boom', 'unconfirmed'],
      // only the tool's say releases: even a rejection or a refused connection may follow an attempt that did the work
      ['a rejection by the service is unconfirmed', {}, false, Object.assign(new Error('declined'), { status: 402 }), 'unconfirmed'],
      ['an error releaseOn accepts releases',
        { releaseOn: (e: unknown) => e instanceof ProviderUnavailable }, false, new ProviderUnavailable('rejected'), 'release'],
      ['a refused connection is unconfirmed', {}, false, netError({ code: 'ECONNREFUSED' }), 'unconfirmed'],
      ['a timeout is unconfirmed', {}, false, netError({ name: 'TimeoutError' }), 'unconfirmed'],
      ['a 5xx is unconfirmed', {}, false, Object.assign(new Error('server error'), { status: 500 }), 'unconfirmed'],
      ['an error unconfirmedOn accepts is unconfirmed',
        { unconfirmedOn: (e: unknown) => e instanceof ProviderUnavailable }, false, new ProviderUnavailable('503 after sending'), 'unconfirmed'],
      // the downstream dedupes the retry by key
      ['a timeout with releaseUnconfirmed is abandoned', { releaseUnconfirmed: true }, false, netError({ name: 'TimeoutError' }), 'abandon'],
      ['an unconfirmedOn hook that throws counts as unconfirmed',
        { unconfirmedOn: (e: unknown) => (e as { response: { status: number } }).response.status === 504 }, false, new Error('card_declined'), 'unconfirmed'],
      // a getter that throws reads as "not there", so this plain error is held
      ['an error whose code getter throws is unconfirmed', {}, false,
        Object.defineProperty(new Error('boom'), 'code', { get() { throw new Error('getter'); } }), 'unconfirmed'],
    ])('%s, and the tool error is rethrown', async (_label, opts, sync, error, outcome) => {
      const charge = idemTool(
        'charge',
        sync
          ? (_args: { amount: number }) => { throw error; }
          : async (_args: { amount: number }) => { await Promise.resolve(); throw error; },
        opts,
      );
      await runIdentity(on, async () => {
        await expect(charge({ amount: 10 })).rejects.toBe(error);
      });
      expect(server.outcomes()).toEqual([outcome]);
      expect(server.settles[0].release).toBe(true); // not a commit: no USD is charged
    });
  });

  describe('settle replies', () => {
    const down = () => new Error('settle down'); // no answer: tried once more
    // [label, settle answers, tool throws?, settles sent, stamped settle_failed?]
    test.each<[string, Array<Reply | Error>, boolean, number, boolean]>([
      ['ok true', [], false, 1, false],
      ['a body that is not JSON', [{ status: 200, data: 'OK' }], false, 1, false],
      ['no body', [{ status: 204 }], false, 1, false],
      ['a 409, lost without a retry', [{ status: 409, data: { detail: 'bad token' } }], false, 1, true],
      ['a 400, lost without a retry', [{ status: 400 }], false, 1, true],
      ['ok false, lost without a retry', [{ status: 200, data: { ok: false, reason: 'redis_unavailable' } }], false, 1, true],
      ['no answer, then ok', [down()], false, 2, false],
      ['no answer twice', [down(), down()], false, 2, true],
      ['a 503, then ok', [{ status: 503 }], false, 2, false],
      ['a resolved 503 twice', [{ status: 503, data: { detail: 'down' }, raw: true }, { status: 503, raw: true }], false, 2, true],
      ['no answer twice, which never masks the tool error', [down(), down()], true, 2, true],
    ])('a settle answered with %s', async (_label, script, throws, sent, stamped) => {
      server.settleScript = script;
      const boom = new TypeError('boom');
      let attrs: Record<string, unknown> = {};
      const sendEmail = idemTool('send_email', (_args: { to: string }) => {
        attrs = currentSpanAttributes();
        if (throws) throw boom;
        return 'ok';
      });
      const result = runIdentity(on, () => sendEmail({ to: 'x@y.z' }));
      if (throws) await expect(result).rejects.toBe(boom);
      else await expect(result).resolves.toBe('ok');
      expect(server.outcomes()).toEqual(Array(sent).fill(throws ? 'unconfirmed' : 'commit'));
      expect(attrs['traccia.idempotency.settle_failed']).toBe(stamped ? true : undefined);
    });

    // [label, credentials cleared?, agent id]
    test.each([
      ['the credentials are', true, 'a1'],
      ['the agent is', false, ''],
    ])('a settle is stamped without a call when %s cleared', async (_label, noCredentials, agentId) => {
      const post = jest.fn();
      _setPepHttpClientForTests({ post } as unknown as AxiosInstance);
      const setAttribute = fakeSpan();
      if (noCredentials) {
        const { loadConfig } = jest.requireMock('../config/config') as { loadConfig: jest.Mock };
        loadConfig.mockReturnValueOnce({ tracing: {} });
      }
      const cleared = ['TRACCIA_AGENT_ID', ...(noCredentials ? ['TRACCIA_API_KEY', 'TRACCIA_ENDPOINT'] : [])];
      await withoutEnv(cleared, () =>
        runIdentity({ agentId, pepEnabled: true }, () => settlePolicy({ obligations: { idempotency: OBLIGATION } })),
      );
      expect(post).not.toHaveBeenCalled();
      expect(setAttribute).toHaveBeenCalledWith('traccia.idempotency.settle_failed', true);
    });

    // A settle with no usage reported: the pricing fields are present but undefined (not sent).
    const NO_USAGE = { model: undefined, vendor: undefined, input_tokens: undefined, output_tokens: undefined };

    // [label, decision, options, the post rejects?, bodies sent]
    test.each<[string, Record<string, unknown> | undefined, Parameters<typeof settlePolicy>[1], boolean, Array<Record<string, unknown>>]>([
      // an LLM settle is sent once, best-effort, and carries no idempotency
      ['an LLM release', { obligations: { reserved_usd: 0.25 } }, { release: true }, true,
        [{ agent_id: 'support', trace_id: undefined, reserved_usd: 0.25, actual_usd: undefined, release: true, ...NO_USAGE }]],
      ['an idempotency release that also reserved USD', { obligations: { idempotency: OBLIGATION, reserved_usd: 0.5 } }, { release: true }, false,
        [{ agent_id: 'support', trace_id: undefined, reserved_usd: 0.5, actual_usd: undefined, release: true, ...NO_USAGE, idempotency: { ...OBLIGATION, outcome: 'release' } }]],
      ['nothing reserved', { obligations: {} }, {}, false, []],
      ['no decision', undefined, {}, false, []],
    ])('settlePolicy sends %s', async (_label, decision, opts, rejects, bodies) => {
      const post = jest.fn(async () => {
        if (rejects) throw new Error('down');
        return { status: 200, data: { ok: true } };
      });
      _setPepHttpClientForTests({ post } as unknown as AxiosInstance);
      await runIdentity({ agentId: 'support', pepEnabled: true }, () => settlePolicy(decision, opts));
      // the fields sent, whatever their order
      expect(post.mock.calls.map((call) => (call as unknown[])[1])).toStrictEqual(bodies);
    });
  });

  describe('definitionValidation', () => {
    const fn = async (_args: { order_id: string }) => undefined;
    function* gen() {
      yield 1;
    }
    async function* agen() {
      yield 1;
    }
    async function named() {
      return 1;
    }
    class Payments {
      refund(_args: { order_id: string }) {
        return 1;
      }
    }
    const method = () => Object.getOwnPropertyDescriptor(Payments.prototype, 'refund')!;
    type Decorate = (target: unknown, ...rest: unknown[]) => unknown;
    const legacyMethod = (d: Decorate) => d(Payments.prototype, 'refund', method());
    const NEEDS_NAME = "idempotent tools need a name: pass observe({ name: '...' })";
    const NOT_FINITE = 'inFlightWaitMs must be a finite number of milliseconds, 0 or more';
    const NOT_FIELD_NAMES = 'keyFields must be an array of field names';
    const id = { name: 'r', asType: 'tool' as const, idempotent: true };

    // [label, options, wrap (default: a function), the error it throws or null]
    test.each<[string, ObserveOptions, ((d: Decorate) => unknown) | null, [ErrorConstructor | TypeErrorConstructor, string] | null]>([
      // options that need idempotent: true
      ['keyFields without idempotent', { asType: 'tool', keyFields: ['to'] }, null, [Error, 'keyFields requires idempotent: true']],
      ['releaseUnconfirmed without idempotent', { asType: 'tool', releaseUnconfirmed: true }, null, [Error, 'unconfirmedOn, releaseOn and releaseUnconfirmed require idempotent: true']],
      ['unconfirmedOn without idempotent', { asType: 'tool', unconfirmedOn: () => true }, null, [Error, 'unconfirmedOn, releaseOn and releaseUnconfirmed require idempotent: true']],
      ['releaseOn without idempotent', { asType: 'tool', releaseOn: () => true }, null, [Error, 'unconfirmedOn, releaseOn and releaseUnconfirmed require idempotent: true']],
      ['keyTypes without idempotent', { asType: 'tool', keyTypes: { a: 'string' } }, null, [Error, 'keyTypes requires idempotent: true']],
      ['inFlightWaitMs without idempotent', { asType: 'tool', inFlightWaitMs: 5 }, null, [Error, 'inFlightWaitMs requires idempotent: true']],
      ['keyExtra without idempotent', { asType: 'tool', keyExtra: () => ({}) }, null, [Error, 'keyExtra requires idempotent: true']],
      ['idempotencyScope without idempotent', { asType: 'tool', idempotencyScope: 'workspace' }, null, [Error, 'idempotencyScope requires idempotent: true']],
      // option values
      ['an unconfirmedOn that is not a function', { ...id, unconfirmedOn: 'x' as never }, null, [TypeError, 'unconfirmedOn must be a function']],
      ['a releaseOn that is not a function', { ...id, releaseOn: 'x' as never }, null, [TypeError, 'releaseOn must be a function']],
      ['both unconfirmedOn and releaseUnconfirmed', { ...id, unconfirmedOn: () => true, releaseUnconfirmed: true }, null, [Error, 'pass unconfirmedOn or releaseUnconfirmed: true, not both']],
      ['an unknown idempotencyScope', { ...id, idempotencyScope: 'org' as never }, null, [Error, "idempotencyScope must be 'agent' or 'workspace'"]],
      ['a keyExtra that is not a function', { ...id, keyExtra: {} as never }, null, [TypeError, 'keyExtra must be a function']],
      ['an async keyExtra', { ...id, keyExtra: async () => 'acct' }, null, [TypeError, 'not a promise']],
      ['a keyTypes kind that is not a type', { ...id, keyTypes: { a: 'text' as never } }, null, [Error, "keyTypes: 'a' must be 'string', 'number' or 'boolean'"]],
      ['keyFields of numbers', { ...id, keyFields: [1] as never }, null, [Error, NOT_FIELD_NAMES]],
      // eslint-disable-next-line no-sparse-arrays
      ['sparse keyFields', { ...id, keyFields: [, 'order_id'] as never }, null, [Error, NOT_FIELD_NAMES]],
      ['keyFields as a Set', { ...id, keyFields: new Set(['to']) as never }, null, [Error, NOT_FIELD_NAMES]],
      ['keyFields as an object', { ...id, keyFields: { to: true } as never }, null, [Error, NOT_FIELD_NAMES]],
      ['empty keyFields', { ...id, keyFields: [] }, null, [Error, 'keyFields must name at least one field']],
      ['an inFlightWaitMs string', { ...id, inFlightWaitMs: '300' as never }, null, [TypeError, NOT_FINITE]],
      ['an inFlightWaitMs of NaN', { ...id, inFlightWaitMs: NaN }, null, [TypeError, NOT_FINITE]],
      ['an inFlightWaitMs of Infinity', { ...id, inFlightWaitMs: Infinity }, null, [TypeError, NOT_FINITE]],
      ['a negative inFlightWaitMs', { ...id, inFlightWaitMs: -1 }, null, [TypeError, NOT_FINITE]],
      // what can be idempotent
      ['an idempotent span', { name: 'r', asType: 'span', idempotent: true }, null, [Error, "idempotent requires asType 'tool'"]],
      ['an idempotent observe with no type', { name: 'r', idempotent: true }, null, [Error, "idempotent requires asType 'tool'"]],
      ['a generator', id, (d) => d(gen), [TypeError, 'idempotent tools cannot be generators in v1']],
      ['an async generator', id, (d) => d(agen), [TypeError, 'idempotent tools cannot be generators in v1']],
      ['an unnamed tool', { asType: 'tool', idempotent: true }, null, [Error, NEEDS_NAME]],
      // bundlers rename functions, so keys would change each build and two tools could collide
      ['a named function without a name option', { asType: 'tool', idempotent: true }, (d) => d(named), [Error, NEEDS_NAME]],
      ['a legacy method decorator without a name option', { asType: 'tool', idempotent: true }, legacyMethod, [Error, NEEDS_NAME]],
      ['a TC39 getter decorator', id, (d) => d(function () { return 1; }, { kind: 'getter', name: 'x' }), [TypeError, 'not a getter']],
      ['a target that is not a function', id, (d) => d(42), [TypeError, 'could not wrap this target']],
      // accepted
      ['a single keyFields string', { ...id, keyFields: 'to' as never }, null, null],
      ['the type alias', { name: 'r', type: 'tool', idempotent: true, keyFields: ['to'] }, null, null],
      ['the as_type alias', { name: 'r', as_type: 'tool', idempotent: true }, null, null],
      ['an inFlightWaitMs of 0', { ...id, inFlightWaitMs: 0 }, null, null],
      ['an inFlightWaitMs of 300', { ...id, inFlightWaitMs: 300 }, null, null],
      ['an unnamed tool that is not idempotent', { asType: 'tool' }, (d) => d(async () => 1), null],
      ['a named legacy method decorator', { ...id, name: 'payments_refund' }, legacyMethod, null],
    ])('%s', (_label, opts, wrap, expected) => {
      const decorate = observe(opts) as unknown as Decorate;
      const define = () => (wrap ?? ((d: Decorate) => d(fn)))(decorate);
      if (expected === null) {
        expect(define).not.toThrow();
        return;
      }
      const [type, message] = expected;
      expect(define).toThrow(message);
      expect(define).toThrow(type);
    });
  });

  describe('keyingThroughTheDecorator', () => {
    const K = (args: Record<string, unknown>) => deriveKey('a1', 't', args);
    const mcpExtra = (more: Record<string, unknown> = {}) => ({ signal: new AbortController().signal, ...more });
    const noop = async () => undefined;
    class RuntimeContext { registry = new Map(); }
    class Mastra { agents = {}; }
    const mastra = (order: string, thread: string) => ({
      context: { order_id: order }, runtimeContext: new RuntimeContext(), mastra: new Mastra(), threadId: thread, resourceId: 'r',
    });
    class Mail {
      to = 'x@y.z';
    }
    /** The span's function.args attribute reads it first; keying is the second read. */
    const throwsOnSecondRead = () => {
      let reads = 0;
      return {
        get pan(): string {
          reads += 1;
          if (reads > 1) throw new RangeError('pan 4111111111111111');
          return '4111111111111111';
        },
      };
    };
    const typed = { order_id: '123', amount: 10.5, refund_all: true };
    const keyTypes = { order_id: 'string', amount: 'number', refund_all: 'boolean' } as const;
    type Sent = string | { unkeyable: string };
    const unkeyable = (reason: string): Sent => ({ unkeyable: reason });
    const NEEDS_OBJECT = unkeyable('keyFields needs an object as the first argument');

    // [label, options, the calls' arguments, what each call is keyed as]
    test.each<[string, Partial<ObserveOptions>, () => unknown[][], Sent[]]>([
      ['no arguments, like a Python tool with none', {}, () => [[]], [K({})]],
      ['no arguments, with an optional key field', { keyFields: ['to?'] }, () => [[]], [K({})]],
      ['an undefined or null first argument, like no argument', {}, () => [[undefined, { toolCallId: 'x' }], [null, { toolCallId: 'y' }]], [K({}), K({})]],
      ['an undefined first argument, with an optional key field', { keyFields: ['region?'] }, () => [[undefined]], [K({})]],
      ['the first object only, whatever a framework passes after it', {},
        () => [[{ order_id: 'o1' }], [{ order_id: 'o1' }, { toolCallId: 'c1', messages: [], abortSignal: new AbortController().signal }],
          [{ order_id: 'o1' }, { toolCallId: 'c2' }], [{ order_id: 'o1' }, undefined]],
        Array(4).fill(K({ order_id: 'o1' }))],
      ['the selected fields of the first object, whatever follows', { keyFields: ['order_id'] },
        () => [[{ order_id: 'o1', note: 'x' }, { toolCallId: 'c3', messages: [], abortSignal: new AbortController().signal }], [{ order_id: 'o1', note: 'y' }, { toolCallId: 'c4' }]],
        Array(2).fill(K({ order_id: 'o1' }))],
      ['a first argument that is not an object, whatever follows', {},
        () => [['order_1', { toolCall: { id: 'A' }, metadata: { run: 'A' }, recursionLimit: 25 }], ['order_1', { abortSignal: new AbortController().signal }],
          ['order_1', { toolCallId: 'B' }], ['order_1']],
        Array(4).fill(K({ args: ['order_1'] }))],
      ['an MCP request extra (a tool with no input schema), like no argument', {},
        () => [[mcpExtra({ sessionId: 's1', requestId: 1, sendNotification: noop, sendRequest: noop })],
          [mcpExtra({ sessionId: 's1', requestId: 2, sendNotification: noop, sendRequest: noop })],
          [mcpExtra()], [mcpExtra({ sessionId: 's1' })], [mcpExtra({ sessionId: 's1', sendNotification: noop, sendRequest: noop })],
          [mcpExtra({ sessionId: 's1', requestId: 3, _meta: { progressToken: 1 }, authInfo: { token: 't' } })]],
        Array(6).fill(K({}))],
      ['an argument object that carries an AbortSignal, as itself', {}, () => [[mcpExtra({ order_id: 'o_1' })]], [unkeyable('signal is AbortSignal')]],
      ["a Mastra tool by its context, leaving the run's plumbing out", {},
        () => [[mastra('o_1', 't1'), { toolCallId: 'call_t1', abortSignal: new AbortController().signal }], [mastra('o_1', 't2')], [mastra('o_2', 't1')]],
        [K({ order_id: 'o_1' }), K({ order_id: 'o_1' }), K({ order_id: 'o_2' })]],
      ['model JSON with a context field and plain-object plumbing, as itself', {},
        () => [[{ context: { order_id: 'o_1' }, runtimeContext: { x: 1 } }]], [K({ context: { order_id: 'o_1' }, runtimeContext: { x: 1 } })]],
      ['drifting argument types alike with keyTypes', { keyTypes },
        () => [[typed], [{ order_id: 123, amount: '10.50', refund_all: 'TRUE' }]], Array(2).fill(K(coerceKeyTypes(typed, keyTypes)))],
      ['a keyFields name the call lacks: still keyed, not a deny', { keyFields: ['to', 'too'] }, () => [[{ to: 'x@y.z' }]], [K({ to: 'x@y.z' })]],
      ['keyExtra returning undefined, like no keyExtra', { keyExtra: () => undefined }, () => [[{ order_id: 'o1' }]], [K({ order_id: 'o1' })]],
      ['an unkeyable argument: unkeyable, with its reason', {}, () => [[{ client: new Map(), to: 'x@y.z' }]], [unkeyable('client is Map')]],
      ['a single argument that is not a plain object: unkeyable', {}, () => [[new Map([['to', 'x@y.z']])]], [unkeyable('args[0] is Map')]],
      ['keyFields with two arguments: unkeyable', { keyFields: ['to'] }, () => [['x@y.z', 'hi']], [NEEDS_OBJECT]],
      ['keyFields with a string argument: unkeyable', { keyFields: ['to'] }, () => [['x@y.z']], [NEEDS_OBJECT]],
      ['keyFields with a class instance: unkeyable', { keyFields: ['to'] }, () => [[new Mail()]], [NEEDS_OBJECT]],
      // only the error's type goes on the wire, never its message
      ['an error while keying: unkeyable by its type', {}, () => [[throwsOnSecondRead()]], [unkeyable('RangeError while keying arguments')]],
      ['a throwing keyExtra: unkeyable by its type',
        { keyExtra: () => { throw new RangeError('secret-tenant-id'); } }, () => [[{ order_id: 'o1' }]], [unkeyable('RangeError while computing keyExtra')]],
    ])('keys %s', async (_label, opts, calls, expected) => {
      let ran = 0;
      const tool = idemTool('t', (..._args: unknown[]) => {
        ran += 1;
        return idempotencyKey(); // throws the Unkeyable for an unkeyable call
      }, opts);
      const results: unknown[] = [];
      await runIdentity(on, async () => {
        for (const args of calls()) results.push(await tool(...args).catch((e: unknown) => e));
      });
      expect(ran).toBe(expected.length); // an unkeyable call still runs
      expect(server.checks.map((c) => c.action.idempotent)).toEqual(expected.map(() => true));
      expect(server.checks.map((c) => c.context.idempotency)).toEqual(
        expected.map((e) => (typeof e === 'string' ? { key: e, fallback_key: keyed(e) } : e)),
      );
      results.forEach((result, i) => {
        const e = expected[i];
        if (typeof e === 'string') {
          expect(result).toBe(keyed(e));
        } else {
          expect(result).toBeInstanceOf(Unkeyable);
          expect((result as Error).message).toBe(e.unkeyable);
        }
      });
      // nothing was reserved for an unkeyable call, so nothing is settled
      expect(server.settles).toHaveLength(expected.filter((e) => typeof e === 'string').length);
    });

    it('gives every agent the same key with idempotencyScope workspace', async () => {
      const refund = idemTool('issue_refund', (_args: { order_id: string }) => idempotencyKey(), { idempotencyScope: 'workspace' });
      const a = await runIdentity({ agentId: 'billing-agent', pepEnabled: true }, () => refund({ order_id: 'o1' }));
      const b = await runIdentity({ agentId: 'support-agent', pepEnabled: true }, () => refund({ order_id: 'o1' }));
      expect(a).toBe(b);
      expect(a).toBe(keyed(deriveKey(undefined, 'issue_refund', { order_id: 'o1' })));
      expect(server.checks.map((c) => c.action.idempotency_scope)).toEqual(['workspace', 'workspace']);
      expect(server.checks.map((c) => c.agent_id)).toEqual(['billing-agent', 'support-agent']);
    });

    it('mixes keyExtra into the key, called with the tool this and arguments', async () => {
      class Payments {
        constructor(public accountId: string) {}
      }
      const refund = idemTool(
        'refund',
        function (this: Payments, _args: { order_id: string }) {
          return idempotencyKey();
        },
        {
          keyExtra: function (this: Payments) {
            return { account: this.accountId };
          },
        },
      );
      const a = await runIdentity(off, () => refund.call(new Payments('acct_1'), { order_id: 'o1' }));
      const b = await runIdentity(off, () => refund.call(new Payments('acct_2'), { order_id: 'o1' }));
      expect(a).not.toBe(b);
      expect(a).toBe(keyed(deriveKey('a1', 'refund', { order_id: 'o1' }, undefined, { account: 'acct_1' })));
    });
  });

  describe('downstream key', () => {
    // [label, the per-attempt key the check hands back, the key the tool gets (undefined: the keyed call key)]
    test.each([
      ['a valid per-attempt key is passed downstream', DOWNSTREAM, DOWNSTREAM],
      ['null falls back to the keyed call key', null, undefined],
      ['an empty string falls back', '', undefined],
      ['a short key falls back', 'idk1_short', undefined],
      ['an uppercase prefix falls back', 'IDK1_' + 'b'.repeat(64), undefined],
      ['a number falls back', 123, undefined],
    ])('%s', async (_label, fromCheck, expected) => {
      const seen: { key?: string; attrs?: Record<string, unknown> } = {};
      const charge = idemTool('charge', async (_args: { amount: number }) => {
        await Promise.resolve();
        seen.key = idempotencyKey();
        seen.attrs = currentSpanAttributes();
      });
      server.downstreamKey = fromCheck;
      await runIdentity(on, () => charge({ amount: 10 }));
      const callKey = server.checks[0].context.idempotency.key;
      expect(seen.key).toBe(expected ?? keyed(callKey));
      expect(seen.key).not.toBe(callKey);
      expect(seen.attrs!['traccia.idempotency.key']).toBeUndefined();
      expect(seen.attrs!['traccia.idempotency.downstream_key']).toBe(seen.key);
      expect(server.settles[0].idempotency.key).toBe(callKey); // settles still name the call key
    });
  });

  describe('denials', () => {
    // [label, check reasons, obligations, tool options, the IdempotencyRepeatError or null for a plain AgentBlockedError]
    test.each<[string, string[], Record<string, unknown> | undefined, Partial<ObserveOptions>, { reason: string; alreadyDone: boolean } | null]>([
      ['a repeat says the call was already done', ['idempotency_repeat'], undefined, {}, { reason: 'idempotency_repeat', alreadyDone: true }],
      ['an unconfirmed call is not known to be done', ['idempotency_unconfirmed'], undefined, {}, { reason: 'idempotency_unconfirmed', alreadyDone: false }],
      ['an in-flight call, with no wait', ['idempotency_in_flight'], undefined, { inFlightWaitMs: 0 }, { reason: 'idempotency_in_flight', alreadyDone: false }],
      // an Observe idempotency policy's reason beside a Block policy's deny: the server sets no
      // idempotency_denied, so no step is skipped as "already done" and nothing waits
      ['an observed repeat beside another policy blocks plainly', ['Spend cap exceeded', 'idempotency_repeat'], {}, {}, null],
      ['an observed in-flight call beside another policy blocks plainly, without waiting', ['Spend cap exceeded', 'idempotency_in_flight'], {}, {}, null],
      ['another policy blocks plainly', ['High-Risk Tool blocked charge'], undefined, {}, null],
    ])('%s', async (_label, reasons, obligations, opts, repeat) => {
      server.check = denyReply(reasons, obligations);
      let ran = false;
      const charge = idemTool('charge', (_args: { amount: number }) => {
        ran = true;
      }, opts);
      const error = await Promise.resolve(runIdentity(on, () => charge({ amount: 10 }))).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AgentBlockedError); // existing handlers still catch it
      if (repeat) {
        expect(error).toBeInstanceOf(IdempotencyRepeatError);
        expect(error).toMatchObject({ name: 'IdempotencyRepeatError', ...repeat });
      } else {
        expect(error).not.toBeInstanceOf(IdempotencyRepeatError);
      }
      expect(ran).toBe(false);
      expect(server.checks).toHaveLength(1);
      expect(server.settles).toEqual([]);
    });
  });

  describe('inFlight', () => {
    let clock: { slept: number[] };
    beforeEach(() => {
      clock = fakeClock();
    });
    const IN_FLIGHT = denyReply(['idempotency_in_flight']);
    // [label, check answers before the reservation, inFlightWaitMs, sleeps, the repeat error or null when it ran]
    test.each<[string, Reply[], number | undefined, number[], { reason: string; alreadyDone: boolean } | null]>([
      ['the first call failed: waits, then runs', [IN_FLIGHT, IN_FLIGHT], undefined, [500, 1000], null],
      ['the first call succeeded: waits, then repeats', [IN_FLIGHT, denyReply(['idempotency_repeat'])], undefined, [500], { reason: 'idempotency_repeat', alreadyDone: true }],
      ['still in flight: gives up after inFlightWaitMs', Array(50).fill(IN_FLIGHT), 5000, [500, 1000, 2000], { reason: 'idempotency_in_flight', alreadyDone: false }],
    ])('%s', async (_label, script, inFlightWaitMs, slept, repeat) => {
      server.checkScript = [...script];
      const ran: number[] = [];
      const charge = idemTool('charge', (args: { amount: number }) => {
        ran.push(args.amount);
        return 'charged';
      }, inFlightWaitMs === undefined ? {} : { inFlightWaitMs });
      const result = await Promise.resolve(runIdentity(on, () => charge({ amount: 10 }))).catch((e: unknown) => e);
      expect(clock.slept).toEqual(slept);
      // each re-check is flagged, so the server neither counts nor stores it as another call
      expect(server.checks.map((c) => c.context.idempotency.recheck)).toEqual([undefined, ...slept.map(() => true)]);
      if (repeat) {
        expect(result).toBeInstanceOf(IdempotencyRepeatError);
        expect(result).toMatchObject(repeat);
        expect(ran).toEqual([]);
      } else {
        expect(result).toBe('charged');
        expect(ran).toEqual([10]);
        expect(server.outcomes()).toEqual(['commit']);
      }
    });

    it('fails at once, without waiting, when a tool calls itself with the same key under Block', async () => {
      const key = deriveKey('a1', 'refund', { order_id: 'o1' });
      server.checkScript = [
        { status: 200, data: { id: 'd1', effect: 'allow', would_have: false, reasons: [], obligations: { idempotency: { key, token: IDEM_TOKEN, window_s: 3600 } } } },
        IN_FLIGHT,
      ];
      // eslint-disable-next-line prefer-const
      let refund: (args: { order_id: string; depth?: number }) => Promise<string>;
      refund = idemTool(
        'refund',
        async (args: { order_id: string; depth?: number }) => ((args.depth ?? 0) === 0 ? refund({ order_id: args.order_id, depth: 1 }) : 'inner'),
        { keyFields: ['order_id'], inFlightWaitMs: 30000 },
      );
      const err = await Promise.resolve(runIdentity(on, () => refund({ order_id: 'o1' }))).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IdempotencyRepeatError);
      expect((err as IdempotencyRepeatError).reason).toBe('idempotency_in_flight');
      expect(server.checks).toHaveLength(2); // the inner call is still checked
      expect(clock.slept).toEqual([]); // no wait on its own reservation
    });

    // [label, PEP on?, the inner call's order id]: the inner call is checked (when on), allowed, and runs
    test.each([
      ['with the same key when no Block policy stops it', true, 'o1'],
      ['with another key', true, 'o2'],
      ['with the same key when checks are off', false, 'o1'],
    ])('lets a tool call itself %s', async (_label, pepEnabled, innerOrder) => {
      // eslint-disable-next-line prefer-const
      let refund: (args: { order_id: string; depth?: number }) => Promise<string>;
      refund = idemTool(
        'refund',
        async (args: { order_id: string; depth?: number }) => ((args.depth ?? 0) === 0 ? refund({ order_id: innerOrder, depth: 1 }) : 'inner'),
        { keyFields: ['order_id'] },
      );
      await expect(runIdentity({ agentId: 'a1', pepEnabled }, () => refund({ order_id: 'o1' }))).resolves.toBe('inner');
      expect(server.checks).toHaveLength(pepEnabled ? 2 : 0);
      expect(server.outcomes()).toEqual(pepEnabled ? ['commit', 'commit'] : []);
    });

    it('treats a call a finished tool left behind as a new call, not a re-entry', async () => {
      let release!: () => void;
      let later!: Promise<unknown>;
      // eslint-disable-next-line prefer-const
      let refund: (args: { order_id: string; again?: boolean }) => Promise<string>;
      refund = idemTool(
        'refund',
        async (args: { order_id: string; again?: boolean }) => {
          if (!args.again) {
            // Runs after this call returned, in the async context the call created.
            later = new Promise<void>((r) => (release = r)).then(() => refund({ order_id: args.order_id, again: true }));
          }
          return 'ran';
        },
        { keyFields: ['order_id'] },
      );
      await runIdentity(on, async () => {
        expect(await refund({ order_id: 'o1' })).toBe('ran');
        server.checkScript = [IN_FLIGHT]; // someone else holds it for a moment
        release();
        expect(await later).toBe('ran'); // waited and ran; a re-entry would be refused at once
      });
      expect(clock.slept).toHaveLength(1);
    });

    it('jitters re-check delays between 50% and 150%', () => {
      const random = jest.spyOn(Math, 'random');
      try {
        random.mockReturnValueOnce(0).mockReturnValueOnce(0.5).mockReturnValueOnce(0.999);
        expect([jitteredDelay(2000), jitteredDelay(2000), jitteredDelay(2000)]).toEqual([1000, 2000, 2998]);
      } finally {
        random.mockRestore();
      }
    });
  });

  describe('arguments JSON cannot encode', () => {
    const closed = { ...on, pepFailMode: 'closed' as const };

    beforeEach(() => _setPepHttpClientForTests(server.wireClient()));

    it('runs a tool given a bigint and posts the check', async () => {
      const charge = idemTool('charge', async (_args: { n: bigint }) => idempotencyKey());
      const callKey = deriveKey('a1', 'charge', { n: 5n });
      expect(await runIdentity(closed, () => charge({ n: 5n }))).toBe(keyed(callKey));
      expect(server.checks).toHaveLength(1);
      expect(server.checks[0].context.input).toEqual({ n: '5' });
      expect(server.checks[0].context.idempotency).toEqual({ key: callKey, fallback_key: keyed(callKey) });
    });

    it('runs a tool given a circular client excluded by keyFields and posts the check', async () => {
      class SmtpClient {
        self: SmtpClient = this;
        token = 'sk_live_secret';
      }
      const sendEmail = idemTool('send_email', async (_args: { to: string; client: SmtpClient }) => idempotencyKey(), { keyFields: ['to'] });
      const key = await runIdentity(closed, () => sendEmail({ to: 'x@y.z', client: new SmtpClient() }));
      expect(key).toBe(keyed(deriveKey('a1', 'send_email', { to: 'x@y.z' })));
      expect(server.checks).toHaveLength(1);
      expect(server.checks[0].context.input).toEqual({ to: 'x@y.z', client: '<SmtpClient>' });
      expect(JSON.stringify(server.checks[0])).not.toContain('sk_live');
    });

    it('keeps a JSON-encodable input as the same object', async () => {
      class Dto {
        a = 1;
      }
      const input = { s: 'x', d: new Date(0), dto: new Dto(), list: [1, { b: null }], skip: undefined };
      const tool = observe({ name: 'plain', asType: 'tool' })(async (_args: typeof input) => 'ok');
      const post = jest.fn(async () => ({
        status: 200,
        data: { id: 'd', effect: 'allow', would_have: false, reasons: [], obligations: {} },
      }));
      _setPepHttpClientForTests({ post } as unknown as AxiosInstance);
      await runIdentity(closed, () => tool(input));
      const body = (post.mock.calls[0] as unknown[])[1] as Record<string, any>;
      expect(body.context.input).toBe(input);
    });
  });
});
