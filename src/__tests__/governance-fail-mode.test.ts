/**
 * TRC-342: what govern() policy checks do when Traccia gives no answer.
 *
 * The customer's setting (Settings -> Policy Enforcement) arrives on answers the SDK
 * already gets: the agent-status answer at the start of a run and each check answer.
 * The mode, or a local override, applies only when Traccia gives no answer.
 */

import type { AxiosInstance } from 'axios';
import { runIdentity, pepFailMode, setAgentId } from '../config/runtime-config';
import { configureGovernance, govConfig } from '../governance/config';
import * as failMode from '../governance/fail-mode';
import { govern } from '../governance/govern';
import { checkPolicy, _resetPepStateForTests, _setPepHttpClientForTests } from '../governance/pep';
import {
  AgentBlockedError,
  ApprovalPending,
  GovernanceConfigError,
  checkAgentStatus,
  _clearStatusCacheForTests,
  _resetPolicyStateForTests,
  _setHttpClientForTests,
} from '../governance/policy';
import { observe } from '../instrumentation/decorator';
import { wrapOpenAICreate } from '../instrumentation/openai';

const KEY = 'tr_live_key';
const ENDPOINT = 'https://api.traccia.ai/v1/traces';
const BASE = 'https://api.traccia.ai';
const IDENT = failMode.identity(KEY, BASE);

const credentials = { api_key: KEY, endpoint: ENDPOINT } as { api_key?: string; endpoint?: string };

jest.mock('../config/config', () => ({
  loadConfig: jest.fn(() => ({ tracing: { ...credentials } })),
  findConfigFile: jest.fn(),
}));

type Answer = { status: number; data?: unknown } | Error | ((request: Request) => Answer | Promise<Answer>);
interface Request {
  url: string;
  key: string;
  body?: Record<string, unknown>;
}

/** A fake Traccia: status answers on GET, check answers on POST, with axios semantics. */
class Traccia {
  status: Answer = { status: 200, data: { status: 'allowed', agent_id: 'support' } };
  check: Answer = { status: 200, data: decision() };
  gets: Request[] = [];
  posts: Request[] = [];

  private async answer(answer: Answer, request: Request) {
    let a = answer;
    while (typeof a === 'function') a = await a(request);
    if (a instanceof Error) throw a;
    if (a.status < 200 || a.status >= 300) {
      throw Object.assign(new Error(`Request failed with status code ${a.status}`), {
        isAxiosError: true,
        response: { status: a.status, data: a.data },
      });
    }
    return a;
  }

  client(): AxiosInstance {
    return {
      get: async (url: string, config?: { headers?: Record<string, string> }) => {
        const request = { url, key: (config?.headers?.Authorization || '').slice(7) };
        this.gets.push(request);
        return this.answer(this.status, request);
      },
      post: async (url: string, body: Record<string, unknown>, config?: { headers?: Record<string, string> }) => {
        if (url.endsWith('/policy/settle') || url.endsWith('/blocks')) return { status: 200, data: {} };
        const request = { url, key: (config?.headers?.Authorization || '').slice(7), body };
        this.posts.push(request);
        return this.answer(this.check, request);
      },
    } as unknown as AxiosInstance;
  }
}

function decision(effect = 'allow', extra: Record<string, unknown> = {}) {
  return { id: 'dec', effect, would_have: false, reasons: [], ...extra };
}

function ok(data: unknown) {
  return { status: 200, data };
}

function statusAnswer(extra: Record<string, unknown> = {}, status = 'allowed') {
  return ok({ status, agent_id: 'support', ...extra });
}

const refused = () => new Error('connect ECONNREFUSED');

let traccia: Traccia;

function checked(run: { pepFailMode?: 'open' | 'closed' } = {}) {
  return runIdentity({ agentId: 'support', pepEnabled: true, ...run }, () =>
    checkPolicy({ action: { type: 'llm_call', name: 'llm_call', model: 'gpt-4o' } }),
  ) as Promise<Record<string, unknown>>;
}

function outage() {
  traccia.check = refused();
  traccia.status = refused();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  _resetPolicyStateForTests();
  _resetPepStateForTests();
  credentials.api_key = KEY;
  credentials.endpoint = ENDPOINT;
  failModeTtl(600_000);
  failMode.failModeSettings.cacheMax = 10_000;
  traccia = new Traccia();
  _setHttpClientForTests(traccia.client());
  _setPepHttpClientForTests(traccia.client());
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  setAgentId(undefined);
  delete process.env.TRACCIA_AGENT_ID;
});

function failModeTtl(ms: number) {
  failMode.failModeSettings.ttlMs = ms;
}

// --- defaults and where the setting comes from ---------------------------------

describe('defaults and sources', () => {
  it('blocks when there is no setting and no answer', async () => {
    outage();
    await expect(checked()).rejects.toThrow('policy fail mode is closed');
    await expect(checkAgentStatus('support')).rejects.toThrow('policy fail mode is closed');
  });

  it('applies the setting from the status answer to the run’s checks', async () => {
    traccia.status = statusAnswer({ fail_mode: 'open', fail_mode_version: 5 });
    await checkAgentStatus('support');
    outage();
    await expect(checked()).resolves.toMatchObject({ effect: 'allow', reasons: ['check_error'] });
  });

  it('applies the setting from a check answer to later checks', async () => {
    traccia.check = ok(decision('allow', { fail_mode: 'open', fail_mode_version: 5 }));
    await checked();
    outage();
    await expect(checked()).resolves.toMatchObject({ effect: 'allow' });
  });

  it('a delayed status answer cannot replace a newer check answer', async () => {
    traccia.check = ok(decision('allow', { fail_mode: 'closed', fail_mode_version: 20 }));
    await checked();
    traccia.status = statusAnswer({ fail_mode: 'open', fail_mode_version: 10 });
    await checkAgentStatus('support');
    outage();
    await expect(checked()).rejects.toBeInstanceOf(AgentBlockedError);
  });

  it('a delayed check answer cannot replace a newer status answer', async () => {
    traccia.status = statusAnswer({ fail_mode: 'open', fail_mode_version: 20 });
    await checkAgentStatus('support');
    traccia.check = ok(decision('allow', { fail_mode: 'closed', fail_mode_version: 10 }));
    await checked();
    outage();
    await expect(checked()).resolves.toMatchObject({ effect: 'allow' });
  });

  it('a slower answer with a newer version still wins', () => {
    failMode.noteAnswer(IDENT, { fail_mode: 'closed', fail_mode_version: 20 }, 2);
    failMode.noteAnswer(IDENT, { fail_mode: 'open', fail_mode_version: 30 }, 1);
    expect(failMode.customerMode(IDENT)).toBe('open');
  });

  it('shares the setting across separately bundled copies', () => {
    let copy: typeof import('../governance/fail-mode') | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      copy = require('../governance/fail-mode');
    });
    expect(copy).not.toBe(failMode);
    copy!.noteAnswer(IDENT, { fail_mode: 'open', fail_mode_version: 1 }, 0);
    expect(failMode.customerMode(IDENT)).toBe('open');
  });
});

// --- null clears; omission preserves --------------------------------------------

describe('null clears; omission preserves', () => {
  it('null with a newer version clears the setting', async () => {
    traccia.status = statusAnswer({ fail_mode: 'open', fail_mode_version: 5 });
    await checkAgentStatus('support');
    traccia.check = ok(decision('allow', { fail_mode: null, fail_mode_version: 6 }));
    await checked();
    outage();
    await expect(checked()).rejects.toBeInstanceOf(AgentBlockedError);
  });

  it('null with an older version does not clear', () => {
    failMode.noteAnswer(IDENT, { fail_mode: 'open', fail_mode_version: 6 }, 1);
    failMode.noteAnswer(IDENT, { fail_mode: null, fail_mode_version: 5 }, 2);
    expect(failMode.customerMode(IDENT)).toBe('open');
  });

  it.each([
    ['both missing', {}],
    ['version missing', { fail_mode: null }],
    ['mode missing', { fail_mode_version: 99 }],
  ])('leaves the setting unchanged when fields are %s', async (_name, fields) => {
    traccia.status = statusAnswer({ fail_mode: 'open', fail_mode_version: 5 });
    await checkAgentStatus('support');
    _clearStatusCacheForTests(); // the next status is a real answer
    traccia.status = statusAnswer(fields);
    await checkAgentStatus('support');
    traccia.check = ok(decision('allow', fields));
    await checked();
    expect(failMode.customerMode(IDENT)).toBe('open');
  });

  it.each([
    ['no would_have', { effect: 'allow', fail_mode: 'open' }],
    ['string would_have', { effect: 'allow', would_have: 'false' }],
    ['no effect', { effect: null, would_have: false }],
    ['unknown effect', { effect: 'unexpected', would_have: false }],
    ['unknown mode', { effect: 'allow', would_have: false, fail_mode: 'OPEN', fail_mode_version: 9 }],
    ['string version', { effect: 'allow', would_have: false, fail_mode: 'open', fail_mode_version: '9' }],
    ['negative version', { effect: 'allow', would_have: false, fail_mode: 'open', fail_mode_version: -1 }],
    ['array', ['allow']],
  ])('treats an invalid decision (%s) as no answer and keeps the setting', async (_name, body) => {
    traccia.check = ok(body);
    await expect(checked()).rejects.toThrow('invalid decision');
    expect(failMode.customerMode(IDENT)).toBeNull();
  });

  it('treats an invalid status answer as no answer', async () => {
    traccia.status = ok({ status: 'allowed', fail_mode: 'sometimes', fail_mode_version: 1 });
    await expect(checkAgentStatus('support')).rejects.toThrow('invalid status answer');
  });
});

// --- lifetime -------------------------------------------------------------------

describe('lifetime', () => {
  it('expires back to closed', async () => {
    failModeTtl(50);
    traccia.check = ok(decision('allow', { fail_mode: 'open', fail_mode_version: 5 }));
    await checked();
    await sleep(80);
    outage();
    await expect(checked()).rejects.toBeInstanceOf(AgentBlockedError);
  });

  it('does not renew the setting from a cached status', async () => {
    // A cache hit before expiry must not extend it: the setting still expires
    // TTL after the real answer.
    failModeTtl(300);
    traccia.status = statusAnswer({ fail_mode: 'open', fail_mode_version: 5 });
    await checkAgentStatus('support');
    await sleep(150);
    await checkAgentStatus('support'); // a cache hit while the setting is still fresh
    expect(traccia.gets).toHaveLength(1);
    await sleep(250); // 400 ms after the answer, 250 ms after the cache hit
    outage();
    await expect(checked()).rejects.toBeInstanceOf(AgentBlockedError);
  });

  it('renews the setting only from a real answer', async () => {
    failModeTtl(150);
    traccia.check = ok(decision('allow', { fail_mode: 'open', fail_mode_version: 5 }));
    await checked();
    await sleep(100);
    await checked(); // a real answer, same setting
    await sleep(100);
    outage();
    await expect(checked()).resolves.toMatchObject({ effect: 'allow' });
  });

  it('is bounded', () => {
    failMode.failModeSettings.cacheMax = 3;
    for (let i = 0; i < 5; i++) {
      failMode.noteAnswer(failMode.identity(`key-${i}`, BASE), { fail_mode: 'open', fail_mode_version: 1 }, 0);
    }
    expect(failMode._failModeStateSizeForTests()).toBe(3);
    expect(failMode.customerMode(failMode.identity('key-0', BASE))).toBeNull();
    expect(failMode.customerMode(failMode.identity('key-4', BASE))).toBe('open');
  });

  it('starts without a remembered setting on a new init', () => {
    failMode.noteAnswer(IDENT, { fail_mode: 'open', fail_mode_version: 1 }, 0);
    configureGovernance({ configFile: '/nonexistent/traccia.toml' });
    expect(failMode.customerMode(IDENT)).toBeNull();
  });

  it('rejects an unknown mode at init', () => {
    expect(() =>
      configureGovernance({ policyFailMode: 'sometimes' as 'open', configFile: '/nonexistent/traccia.toml' }),
    ).toThrow('policyFailMode');
  });
});

// --- rejection ------------------------------------------------------------------

describe('rejection', () => {
  it.each([
    [401, 'invalid_api_key'],
    [403, 'permission_denied'],
  ])('refuses a rejected key (%s) even with open', async (status, reason) => {
    govConfig.policyFailMode = 'open';
    traccia.check = ok(decision('allow', { fail_mode: 'open', fail_mode_version: 5 }));
    await checked();
    traccia.check = { status, data: { detail: 'revoked' } };
    const err = await checked({ pepFailMode: 'open' }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentBlockedError);
    expect(err.reasons).toEqual([reason]);
    traccia.status = { status, data: { detail: 'revoked' } };
    await expect(checkAgentStatus('support', { policyFailMode: 'open' })).rejects.toThrow('rejected this API key');
  });

  it.each([
    ['allow', ok(decision('allow', { fail_mode: 'open', fail_mode_version: 9 }))],
    ['http_500', { status: 500, data: { detail: 'down' } }],
    ['timeout', new Error('timeout of 2000ms exceeded')],
    ['malformed', ok({ effect: 'allow' })],
  ] as Array<[string, Answer]>)(
    'refuses a check sent before a rejection, then answered with %s',
    async (_name, late) => {
      // A is sent, B gets 401, a fresh C caches open, then A answers or fails. A must
      // be refused, not allowed through C's open (the sequence behind the gateway bug).
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      let reached: () => void = () => {};
      const sent = new Promise<void>((resolve) => (reached = resolve));
      traccia.check = async () => {
        reached();
        await held;
        return late;
      };
      const a = checked({ pepFailMode: 'open' }).catch((e) => e);
      await sent;

      traccia.check = { status: 401, data: { detail: 'revoked' } };
      await expect(checked()).rejects.toBeInstanceOf(AgentBlockedError);
      traccia.check = ok(decision('allow', { fail_mode: 'open', fail_mode_version: 10 }));
      await checked();
      expect(failMode.customerMode(IDENT)).toBe('open');

      release();
      const err = await a;
      expect(err).toBeInstanceOf(AgentBlockedError);
      expect(err.reasons).toEqual(['invalid_api_key']);
      expect(failMode.customerMode(IDENT)).toBe('open'); // C's answer still stands
    },
  );

  it('refuses a status answer sent before a rejection', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached: () => void = () => {};
    const sent = new Promise<void>((resolve) => (reached = resolve));
    traccia.status = async () => {
      reached();
      await held;
      return statusAnswer({ fail_mode: 'open', fail_mode_version: 9 });
    };
    const status = checkAgentStatus('support').catch((e) => e);
    await sent;
    traccia.check = { status: 401, data: { detail: 'revoked' } };
    await expect(checked()).rejects.toBeInstanceOf(AgentBlockedError);
    release();
    expect(await status).toBeInstanceOf(AgentBlockedError);
    expect(failMode.customerMode(IDENT)).toBeNull();
  });
});

// --- precedence: the override applies only when there is no answer ---------------

describe('precedence', () => {
  it('never lets the open override beat a hard block', async () => {
    traccia.status = statusAnswer({ policy_id: 'pol-1' }, 'hard_block');
    await expect(checkAgentStatus('support', { policyFailMode: 'open' })).rejects.toThrow('hard blocked');
  });

  it('never lets the open override beat a deny', async () => {
    traccia.check = ok(decision('deny', { reasons: ['spend exceeded cap'] }));
    await expect(checked({ pepFailMode: 'open' })).rejects.toThrow('spend exceeded cap');
  });

  it('never lets the open override beat a configuration error', async () => {
    credentials.api_key = undefined;
    const saved = process.env.TRACCIA_API_KEY;
    delete process.env.TRACCIA_API_KEY;
    try {
      await expect(checked({ pepFailMode: 'open' })).rejects.toBeInstanceOf(GovernanceConfigError);
    } finally {
      if (saved !== undefined) process.env.TRACCIA_API_KEY = saved;
    }
    credentials.api_key = KEY;
    await expect(
      runIdentity({ pepEnabled: true, pepFailMode: 'open' }, () => checkPolicy({ action: { type: 'llm_call' } })),
    ).rejects.toThrow('agentId');
  });

  it('keeps Observe/Warn and approvals under closed', async () => {
    traccia.check = ok({ ...decision('deny'), would_have: true });
    await expect(checked({ pepFailMode: 'closed' })).resolves.toMatchObject({ would_have: true });
    traccia.check = ok(decision('queue', { approval_id: 'apr-1' }));
    await expect(checked({ pepFailMode: 'closed' })).rejects.toBeInstanceOf(ApprovalPending);
  });

  it('lets the closed override beat an open setting', async () => {
    traccia.check = ok(decision('allow', { fail_mode: 'open', fail_mode_version: 5 }));
    await checked();
    outage();
    await expect(checked({ pepFailMode: 'closed' })).rejects.toBeInstanceOf(AgentBlockedError);
  });

  it('applies the init override to direct checks', async () => {
    outage();
    setAgentId('support');
    await expect(checkPolicy({ action: { type: 'tool_call', name: 'refund' } })).rejects.toBeInstanceOf(
      AgentBlockedError,
    );
    govConfig.policyFailMode = 'open';
    await expect(checkPolicy({ action: { type: 'tool_call', name: 'refund' } })).resolves.toMatchObject({
      effect: 'allow',
    });
  });

  it('warns once when the override disagrees with Traccia', async () => {
    traccia.check = ok(decision('allow', { fail_mode: 'closed', fail_mode_version: 5 }));
    await checked();
    outage();
    await checked({ pepFailMode: 'open' });
    await checked({ pepFailMode: 'open' });
    const warnings = (console.warn as jest.Mock).mock.calls.filter((c) =>
      String(c[0]).includes('overrides your Traccia setting'),
    );
    expect(warnings).toHaveLength(1);
  });
});

// --- identity -------------------------------------------------------------------

describe('identity', () => {
  it('never shares status or setting between two keys with the same agent', async () => {
    traccia.status = (request) =>
      request.key === 'key-a'
        ? statusAnswer({ policy_id: 'pol', fail_mode: 'open', fail_mode_version: 3 }, 'hard_block')
        : statusAnswer();
    credentials.api_key = 'key-a';
    await expect(checkAgentStatus('support')).rejects.toBeInstanceOf(AgentBlockedError);
    credentials.api_key = 'key-b';
    await expect(checkAgentStatus('support')).resolves.toBeUndefined(); // not key A's cached block
    expect(traccia.gets.map((g) => g.key)).toEqual(['key-a', 'key-b']);
    expect(failMode.customerMode(failMode.identity('key-a', BASE))).toBe('open');
    expect(failMode.customerMode(failMode.identity('key-b', BASE))).toBeNull();
  });

  it('never shares status between two endpoints', async () => {
    await checkAgentStatus('support');
    credentials.endpoint = 'https://eu.traccia.ai/v1/traces';
    await checkAgentStatus('support');
    expect(traccia.gets.map((g) => g.url)).toEqual([
      'https://api.traccia.ai/api/v1/agents/support/status',
      'https://eu.traccia.ai/api/v1/agents/support/status',
    ]);
  });

  it('lets callers sharing one status fetch apply their own override', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    traccia.status = async () => {
      await held;
      return refused();
    };
    const open = checkAgentStatus('support', { policyFailMode: 'open' }).then(
      () => 'allowed',
      () => 'blocked',
    );
    const byDefault = checkAgentStatus('support').then(
      () => 'allowed',
      () => 'blocked',
    );
    release();
    expect(await Promise.all([open, byDefault])).toEqual(['allowed', 'blocked']);
    expect(traccia.gets).toHaveLength(1);
  });
});

// --- govern() --------------------------------------------------------------------

function toolRun(options: Record<string, unknown> = {}) {
  const ran: number[] = [];
  const refund = observe({ asType: 'tool', name: 'refund' })(async ({ amount }: { amount: number }) => {
    ran.push(amount);
    return { refunded: amount };
  });
  const run = govern({ agentId: 'support', name: 'run', ...options })(async () => refund({ amount: 5 })) as () => Promise<unknown>;
  return { run, ran };
}

describe('govern()', () => {
  it('treats failOpen as a deprecated alias for the override', async () => {
    outage();
    const open = toolRun({ failOpen: true });
    await expect(open.run()).resolves.toEqual({ refunded: 5 });
    expect(process.emitWarning).toHaveBeenCalledWith(expect.stringContaining('failOpen'), 'DeprecationWarning');
    const closed = toolRun({ failOpen: false });
    await expect(closed.run()).rejects.toBeInstanceOf(AgentBlockedError);
    expect(closed.ran).toEqual([]);
  });

  it('follows the Traccia setting when failOpen is omitted', async () => {
    const { run } = toolRun();
    expect(process.emitWarning).not.toHaveBeenCalled();
    traccia.status = statusAnswer({ fail_mode: 'open', fail_mode_version: 5 });
    traccia.check = refused();
    await expect(run()).resolves.toEqual({ refunded: 5 }); // the customer chose open
    _resetPolicyStateForTests();
    _setHttpClientForTests(traccia.client());
    traccia.status = refused();
    await expect(run()).rejects.toBeInstanceOf(AgentBlockedError); // nothing known: closed
  });

  it.each([
    [true, 'closed'],
    [false, 'open'],
  ])('rejects failOpen %s with policyFailMode %s', (failOpen, mode) => {
    expect(() => govern({ agentId: 'support', failOpen, policyFailMode: mode as 'open' })(async () => 1)).toThrow(
      'conflicts',
    );
  });

  it('accepts matching failOpen and policyFailMode', () => {
    expect(() => govern({ agentId: 'support', failOpen: true, policyFailMode: 'open' })(async () => 1)).not.toThrow();
  });

  it('never shares an override between concurrent runs', async () => {
    traccia.check = refused();
    const order: string[] = [];
    const openRun = govern({ agentId: 'support', policyFailMode: 'open' })(async () => {
      order.push('open started');
      await sleep(5);
      return (await checkPolicy({ action: { type: 'llm_call' } })).effect;
    }) as () => Promise<unknown>;
    const defaultRun = govern({ agentId: 'support' })(async () => {
      order.push('default started');
      await sleep(5);
      return checkPolicy({ action: { type: 'llm_call' } }).then(
        () => 'allowed',
        () => 'blocked',
      );
    }) as () => Promise<unknown>;

    expect(await Promise.all([openRun(), defaultRun()])).toEqual(['allow', 'blocked']);
    expect(order).toEqual(['open started', 'default started']);
    expect(pepFailMode()).toBeUndefined();
  });

  it('ends an override with its run', async () => {
    traccia.check = refused();
    const openRun = govern({ agentId: 'support', policyFailMode: 'open' })(async () =>
      (await checkPolicy({ action: { type: 'llm_call' } })).effect,
    ) as () => Promise<unknown>;
    await expect(openRun()).resolves.toBe('allow');
    expect(govConfig.policyFailMode).toBeUndefined();
    await expect(checked()).rejects.toBeInstanceOf(AgentBlockedError);
    setAgentId('support');
    await expect(checkPolicy({ action: { type: 'tool_call', name: 'refund' } })).rejects.toBeInstanceOf(
      AgentBlockedError,
    );
  });

  it('applies an override to nested checks', async () => {
    outage();
    const run = govern({ agentId: 'support', policyFailMode: 'open' })(async () => {
      const nested = async () => checkPolicy({ action: { type: 'tool_call', name: 'lookup' } });
      return (await nested()).effect;
    }) as () => Promise<unknown>;
    await expect(run()).resolves.toBe('allow');
  });
});

// --- instrumentation never swallows the new errors -------------------------------

describe('instrumentation', () => {
  it('never sends a blocked LLM call to the provider', async () => {
    const providerCalls: unknown[] = [];
    const create = wrapOpenAICreate(async (params: unknown) => {
      providerCalls.push(params);
      return { id: 'x', choices: [] };
    }, {});
    traccia.check = refused();
    const run = govern({ agentId: 'support' })(async () =>
      create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    ) as () => Promise<unknown>;

    await expect(run()).rejects.toThrow('policy fail mode is closed');
    expect(providerCalls).toEqual([]);
    traccia.check = ok(decision());
    await run();
    expect(providerCalls).toHaveLength(1); // the same wrapper passes an allow
  });
});

// --- review: malformed status, cached status after a rejection, repeated init() ---

describe('review fixes', () => {
  it.each([
    ['empty', {}],
    ['unknown', { status: 'nonsense' }],
    ['null', { status: null }],
    ['number', { status: 5 }],
    ['no status', { agent_id: 'support', fail_mode: 'open', fail_mode_version: 3 }],
  ])('treats a status answer that is %s as no answer', async (_name, body) => {
    traccia.status = ok(body);
    const ran: number[] = [];
    const run = govern({ agentId: 'support' })(async () => ran.push(1)) as () => Promise<unknown>;

    await expect(run()).rejects.toThrow('invalid status answer');
    expect(ran).toEqual([]);
    expect(failMode.customerMode(IDENT)).toBeNull(); // nothing learned from it
    await expect(checkAgentStatus('support', { policyFailMode: 'open' })).resolves.toBeUndefined(); // no answer: override applies
  });

  it('disqualifies cached statuses for every agent of a rejected key', async () => {
    await checkAgentStatus('support');
    await checkAgentStatus('billing');
    expect(traccia.gets).toHaveLength(2); // both cached as allowed
    traccia.check = { status: 401, data: { detail: 'revoked' } };
    await expect(checked()).rejects.toBeInstanceOf(AgentBlockedError); // the key is rejected on a check
    traccia.status = { status: 401, data: { detail: 'revoked' } };
    for (const agent of ['support', 'billing']) {
      await expect(checkAgentStatus(agent, { policyFailMode: 'open' })).rejects.toThrow('rejected this API key');
    }
    expect(traccia.gets).toHaveLength(4); // neither cached allow was reused
    traccia.status = statusAnswer(); // key restored
    await checkAgentStatus('support');
    await checkAgentStatus('support'); // cached again
    expect(traccia.gets).toHaveLength(5);
  });

  it('keeps this key’s cached status when another key is rejected', async () => {
    await checkAgentStatus('support');
    failMode.noteRejection(failMode.identity('other-key', BASE), 401);
    await checkAgentStatus('support');
    expect(traccia.gets).toHaveLength(1);
  });
});
