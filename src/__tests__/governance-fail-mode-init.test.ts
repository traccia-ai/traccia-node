/**
 * TRC-342: calling the public init() again starts policy checks afresh. Tracing
 * stays as it is, the remembered fail mode is forgotten, and the new
 * policyFailMode applies.
 */

import type { AxiosInstance } from 'axios';
import { init, stopTracing } from '../auto';
import { runIdentity } from '../config/runtime-config';
import { govConfig } from '../governance/config';
import * as failMode from '../governance/fail-mode';
import { checkPolicy, _resetPepStateForTests, _setPepHttpClientForTests } from '../governance/pep';
import { AgentBlockedError } from '../governance/policy';

const KEY = 'tr_test_init_fail_mode_key';
const ENDPOINT = 'http://127.0.0.1:9/v1/traces';
const IDENT = failMode.identity(KEY, 'http://127.0.0.1:9');
const CRED_ENV = ['TRACCIA_API_KEY', 'TRACCIA_ENDPOINT', 'AGENT_DASHBOARD_API_KEY', 'AGENT_DASHBOARD_ENDPOINT'];
const base = { apiKey: KEY, endpoint: ENDPOINT, agentId: 'support', loadEnv: false };

describe('calling the public init() again', () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const name of CRED_ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  beforeEach(async () => {
    await stopTracing();
    await init(base);
  });

  afterAll(async () => {
    await stopTracing();
    govConfig.policyFailMode = undefined;
    failMode._clearFailModeStateForTests();
    for (const name of CRED_ENV) {
      if (saved[name] !== undefined) process.env[name] = saved[name];
    }
  });

  it('forgets the remembered setting', async () => {
    failMode.noteAnswer(IDENT, { fail_mode: 'open', fail_mode_version: 5 }, 0);
    expect(failMode.customerMode(IDENT)).toBe('open');
    await init(base);
    expect(failMode.customerMode(IDENT)).toBeNull();
  });

  it('applies its override', async () => {
    await init({ ...base, policyFailMode: 'closed' });
    expect(govConfig.policyFailMode).toBe('closed');
    await init({ ...base, policyFailMode: 'open' });
    expect(govConfig.policyFailMode).toBe('open');
    await expect(init({ ...base, policyFailMode: 'sometimes' as 'open' })).rejects.toThrow('policyFailMode');
  });

  it.each([
    ['allow', { status: 200, data: { id: 'late', effect: 'allow', would_have: false, fail_mode: 'open', fail_mode_version: 9 } }],
    ['timeout', new Error('timeout of 2000ms exceeded')],
  ])('keeps the rejection barrier: a check sent before a 401 stays refused (late %s)', async (_name, late) => {
    // A is sent, B gets 401, init() runs again, then A answers. A must be refused:
    // the re-init forgets settings, not rejections.
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let next: (body: Record<string, unknown>) => Promise<unknown> = async (body) => {
      if ((body.action as Record<string, unknown>).name === 'A') {
        await held;
        if (late instanceof Error) throw late;
        return late;
      }
      return { status: 200, data: {} };
    };
    const reject401 = () =>
      Promise.reject(Object.assign(new Error('Request failed'), { isAxiosError: true, response: { status: 401 } }));
    _setPepHttpClientForTests({
      post: (_url: string, body: Record<string, unknown>) => next(body),
    } as unknown as AxiosInstance);
    const check = (name: string) =>
      runIdentity({ agentId: 'support', pepEnabled: true, pepFailMode: 'open' }, () =>
        checkPolicy({ action: { type: 'llm_call', name } }),
      ) as Promise<Record<string, unknown>>;

    const a = check('A').catch((e) => e);
    await Promise.resolve();
    const original = next;
    next = async (body) => ((body.action as Record<string, unknown>).name === 'A' ? original(body) : reject401());
    await expect(check('B')).rejects.toBeInstanceOf(AgentBlockedError);
    await init({ ...base, policyFailMode: 'open' });
    release();
    const err = await a;
    expect(err).toBeInstanceOf(AgentBlockedError);
    expect(err.reasons).toEqual(['invalid_api_key']);

    next = async () => ({ status: 200, data: { id: 'fresh', effect: 'allow', would_have: false } });
    await expect(check('C')).resolves.toMatchObject({ id: 'fresh' }); // sent after it: answered normally
    _resetPepStateForTests();
    jest.restoreAllMocks();
  });
});
