import { AgentBlockedError, ApprovalPending } from '../governance/policy';
import { runIdentity } from '../config/runtime-config';
import * as pep from '../governance/pep';
import {
  _unpatchOutboundFetchForTests,
  guardFetch,
  outboundHttpEnabled,
  patchOutboundFetch,
  setOutboundHttpChecks,
  shouldCheckOutbound,
} from '../governance/outbound-http';

jest.mock('../config/config', () => ({
  loadConfig: jest.fn(() => ({
    tracing: { api_key: 'test-key', endpoint: 'https://app.traccia.ai/v1/traces' },
  })),
  findConfigFile: jest.fn(),
}));

const PROD = 'https://api.prod.example.com/admin';

type Hop = { status: number; location?: string };

function fakeFetch(hops: Record<string, Hop>) {
  const sent: { url: string; init: Record<string, unknown> | undefined }[] = [];
  const fn = jest.fn(async (input: unknown, init?: Record<string, unknown>) => {
    const url = typeof input === 'string' ? input : String((input as { url: string }).url);
    sent.push({ url, init });
    const hop = hops[url] || { status: 200 };
    return {
      status: hop.status,
      headers: { get: (name: string) => (name === 'location' ? hop.location ?? null : null) },
      body: { cancel: jest.fn() },
    };
  });
  return { fn, sent };
}

function governed<T>(fn: () => Promise<T>): Promise<T> {
  return runIdentity({ agentId: 'support', pepEnabled: true }, fn) as Promise<T>;
}

function checks(opts: { deny?: string; queue?: string } = {}) {
  const seen: [string, string][] = [];
  jest.spyOn(pep, 'checkPolicy').mockImplementation(async ({ action, context }) => {
    const input = (context as { input: { url: string } }).input;
    seen.push([String(action.method), input.url]);
    if (opts.queue && input.url.includes(opts.queue)) throw new ApprovalPending('held', { approvalId: 'a1' });
    if (opts.deny && input.url.includes(opts.deny)) throw new AgentBlockedError('denied by Environment Boundary');
    return { effect: 'allow', would_have: false };
  });
  return seen;
}

describe('outbound HTTP policy checks', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    setOutboundHttpChecks(true);
  });
  afterEach(() => {
    _unpatchOutboundFetchForTests();
    delete process.env.TRACCIA_CHECK_OUTBOUND_HTTP;
  });

  it('is off by default and only inside govern()', async () => {
    setOutboundHttpChecks(undefined);
    expect(outboundHttpEnabled()).toBe(false);
    process.env.TRACCIA_CHECK_OUTBOUND_HTTP = '1';
    expect(outboundHttpEnabled()).toBe(true);
    expect(shouldCheckOutbound(PROD)).toBe(false);
    await governed(async () => expect(shouldCheckOutbound(PROD)).toBe(true));
  });

  it('never checks Traccia itself', async () => {
    await governed(async () => {
      expect(shouldCheckOutbound('https://app.traccia.ai/api/v1/policy/check')).toBe(false);
    });
  });

  it('denies before sending', async () => {
    const seen = checks({ deny: 'prod.example.com' });
    const { fn, sent } = fakeFetch({});
    await governed(async () => {
      await expect(guardFetch(fn)(PROD)).rejects.toBeInstanceOf(AgentBlockedError);
    });
    expect(seen).toEqual([['GET', PROD]]);
    expect(sent).toEqual([]);
  });

  it('checks every redirect hop and never sends the denied one', async () => {
    const seen = checks({ deny: 'prod.example.com' });
    const { fn, sent } = fakeFetch({ 'https://safe.example.com/start': { status: 302, location: PROD } });
    await governed(async () => {
      await expect(guardFetch(fn)('https://safe.example.com/start')).rejects.toBeInstanceOf(AgentBlockedError);
    });
    expect(seen.map(([, url]) => url)).toEqual(['https://safe.example.com/start', PROD]);
    expect(sent.map((s) => s.url)).toEqual(['https://safe.example.com/start']);
    expect(sent[0].init?.redirect).toBe('manual');
  });

  it('follows allowed redirects, relative locations, and 303 as GET without a body', async () => {
    const seen = checks();
    const { fn, sent } = fakeFetch({
      'https://safe.example.com/a': { status: 303, location: '/b' },
      'https://safe.example.com/b': { status: 307, location: 'https://other.example.com/c' },
    });
    const response = await governed(() =>
      guardFetch(fn)('https://safe.example.com/a', { method: 'POST', body: 'x', headers: { Authorization: 'Bearer s', 'X-Ok': '1' } }),
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual([
      ['POST', 'https://safe.example.com/a'],
      ['GET', 'https://safe.example.com/b'],
      ['GET', 'https://other.example.com/c'],
    ]);
    expect(sent.map((s) => s.url)).toEqual(['https://safe.example.com/a', 'https://safe.example.com/b', 'https://other.example.com/c']);
    expect(sent[1].init?.body).toBeUndefined();
    // Credentials are not forwarded to another origin.
    expect(sent[2].init?.headers).toEqual({ 'X-Ok': '1' });
  });

  it('checks once when the caller handles redirects', async () => {
    const seen = checks();
    const { fn, sent } = fakeFetch({ 'https://safe.example.com/a': { status: 302, location: PROD } });
    const response = await governed(() => guardFetch(fn)('https://safe.example.com/a', { redirect: 'manual' }));
    expect(response.status).toBe(302);
    expect(seen).toEqual([['GET', 'https://safe.example.com/a']]);
    expect(sent).toHaveLength(1);
  });

  it('stops on a held approval', async () => {
    checks({ queue: 'prod.example.com' });
    const { fn, sent } = fakeFetch({});
    await governed(async () => {
      await expect(guardFetch(fn)(PROD)).rejects.toBeInstanceOf(ApprovalPending);
    });
    expect(sent).toEqual([]);
  });

  it('passes through untouched when off or outside govern()', async () => {
    const seen = checks({ deny: 'prod.example.com' });
    const { fn } = fakeFetch({});
    await guardFetch(fn)(PROD);
    setOutboundHttpChecks(false);
    await governed(() => guardFetch(fn)(PROD));
    expect(seen).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops after too many redirects', async () => {
    checks();
    const hops: Record<string, Hop> = {};
    for (let i = 0; i < 25; i += 1) hops[`https://safe.example.com/${i}`] = { status: 302, location: `/${i + 1}` };
    const { fn } = fakeFetch(hops);
    await governed(async () => {
      await expect(guardFetch(fn)('https://safe.example.com/0')).rejects.toThrow('too many redirects');
    });
  });

  it('patches globalThis.fetch once', () => {
    _unpatchOutboundFetchForTests();
    const original = globalThis.fetch;
    expect(patchOutboundFetch()).toBe(true);
    const patched = globalThis.fetch;
    expect(patched).not.toBe(original);
    expect(patchOutboundFetch()).toBe(true);
    expect(globalThis.fetch).toBe(patched);
    _unpatchOutboundFetchForTests();
    expect(globalThis.fetch).toBe(original);
  });
});
