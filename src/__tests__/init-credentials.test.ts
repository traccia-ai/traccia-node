/**
 * Credentials passed to init() must reach policy, prompts and evals — not only tracing.
 */

import type { AxiosInstance } from 'axios';
import { init, stopTracing } from '../auto';
import { loadConfig } from '../config/config';
import { checkPolicy, _setPepHttpClientForTests, _resetPepStateForTests } from '../governance/pep';
import { resolveCredentials } from '../prompts/client';

const API_KEY = 'tr_test_init_only_key';
const ENDPOINT = 'http://127.0.0.1:9/v1/traces';
const CRED_ENV = ['TRACCIA_API_KEY', 'TRACCIA_ENDPOINT', 'AGENT_DASHBOARD_API_KEY', 'AGENT_DASHBOARD_ENDPOINT'];

describe('init() credentials are the effective client config', () => {
  const saved: Record<string, string | undefined> = {};
  const post = jest.fn().mockResolvedValue({ data: { effect: 'allow', would_have: false } });

  beforeAll(async () => {
    for (const name of CRED_ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    // Precondition: no env/file credentials anywhere, so init() is the only source.
    expect(loadConfig().tracing.api_key).toBeFalsy();
    expect(loadConfig().tracing.endpoint).toBeFalsy();

    _setPepHttpClientForTests({ post } as unknown as AxiosInstance);
    await init({ apiKey: API_KEY, endpoint: ENDPOINT, agentId: 'agent-1', loadEnv: false });
  });

  afterAll(async () => {
    await stopTracing();
    _resetPepStateForTests();
    for (const name of CRED_ENV) {
      if (saved[name] !== undefined) process.env[name] = saved[name];
    }
  });

  it('policy check calls the policy server with the init credentials', async () => {
    const decision = await checkPolicy({ action: { type: 'llm_call', name: 'llm_call', model: 'gpt-4o-mini' } });

    expect(decision.reasons ?? []).not.toContain('missing_credentials');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('http://127.0.0.1:9/api/v1/policy/check');
    expect(post.mock.calls[0][2].headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('prompt and eval credential resolution uses the init credentials', () => {
    expect(resolveCredentials()).toEqual({ apiKey: API_KEY, baseUrl: 'http://127.0.0.1:9' });
  });

  it('explicit per-call arguments still override init', () => {
    expect(resolveCredentials({ apiKey: 'per-call' }).apiKey).toBe('per-call');
  });
});
