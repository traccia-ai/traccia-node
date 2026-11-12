/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument --
   fetch's input, init and response are untyped here: the SDK builds without DOM types. */
/**
 * Policy checks on outbound HTTP requests (TRC-307 Environment Boundary).
 *
 * With `checkOutboundHttp: true` on init() (or TRACCIA_CHECK_OUTBOUND_HTTP=1),
 * every `fetch` an agent makes inside govern() is checked before it is sent, as
 * an `http_request` action. An Environment Boundary policy can then stop an
 * agent outside production from calling a production URL, even when the call is
 * not a governed tool.
 *
 * Every redirect hop is checked: a request that follows redirects is sent with
 * `redirect: 'manual'`, and each Location is checked before it is requested.
 * A request with `redirect: 'manual'` or `'error'` is checked once, as the caller
 * handles redirects. Requests to Traccia itself are never checked. A deny throws
 * AgentBlockedError and a held approval ApprovalPending before anything is sent.
 */

import { resolveClientCredentials } from '../config/client-config';
import { pepEnabled } from '../config/runtime-config';
import { checkPolicy } from './pep';

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const STATE_KEY = Symbol.for('traccia.outboundHttp');

interface OutboundState {
  enabled?: boolean;
  patched: boolean;
  originalFetch?: any;
}

function state(): OutboundState {
  const host = globalThis as typeof globalThis & { [STATE_KEY]?: OutboundState };
  if (!host[STATE_KEY]) host[STATE_KEY] = { patched: false };
  return host[STATE_KEY];
}

export function outboundHttpEnabled(): boolean {
  const configured = state().enabled;
  if (configured !== undefined) return configured;
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.TRACCIA_CHECK_OUTBOUND_HTTP || '').trim().toLowerCase());
}

export function setOutboundHttpChecks(value: boolean | undefined): void {
  state().enabled = value;
  if (value) patchOutboundFetch();
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function shouldCheckOutbound(url: string): boolean {
  if (!outboundHttpEnabled() || !pepEnabled()) return false;
  const host = hostOf(url);
  if (!host) return false;
  const { endpoint } = resolveClientCredentials();
  return !(endpoint && hostOf(endpoint) === host);
}

export async function checkOutboundRequest(method: string, url: string): Promise<void> {
  if (!shouldCheckOutbound(url)) return;
  const upper = (method || 'GET').toUpperCase();
  await checkPolicy({
    action: { type: 'http_request', name: 'http_request', method: upper },
    context: { input: { url, method: upper } },
  });
}

type AnyInit = Record<string, any> | undefined;

function describe(input: any, init: AnyInit): { url: string; method: string } {
  if (typeof input === 'string') return { url: input, method: String(init?.method || 'GET') };
  if (input && typeof input === 'object' && 'url' in input) {
    return { url: String(input.url), method: String(init?.method || input.method || 'GET') };
  }
  return { url: String(input), method: String(init?.method || 'GET') };
}

function withoutCredentials(headers: unknown): unknown {
  const drop = new Set(['authorization', 'cookie', 'proxy-authorization']);
  if (headers && typeof (headers as { forEach?: unknown }).forEach === 'function' && !Array.isArray(headers)) {
    const out: Record<string, string> = {};
    (headers as { forEach(cb: (value: string, key: string) => void): void }).forEach((value, key) => {
      if (!drop.has(key.toLowerCase())) out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return headers.filter((pair) => !drop.has(String((pair as unknown[])[0]).toLowerCase()));
  }
  if (headers && typeof headers === 'object') {
    return Object.fromEntries(Object.entries(headers as Record<string, unknown>).filter(([k]) => !drop.has(k.toLowerCase())));
  }
  return headers;
}

/** fetch with a policy check before each hop. */
export function guardFetch(originalFetch: any) {
  return async function checkedFetch(input: any, init?: AnyInit): Promise<any> {
    const first = describe(input, init);
    if (!shouldCheckOutbound(first.url)) {
      return originalFetch(input, init);
    }
    const redirect = init?.redirect ?? (input && typeof input === 'object' ? input.redirect : undefined) ?? 'follow';
    await checkOutboundRequest(first.method, first.url);
    if (redirect !== 'follow') {
      return originalFetch(input, init);
    }
    let url = first.url;
    let method = first.method.toUpperCase();
    let nextInput = input;
    let nextInit: AnyInit = { ...(init || {}), redirect: 'manual' };
    for (let hop = 0; ; hop += 1) {
      const response = await originalFetch(nextInput, nextInit);
      const location = response?.headers?.get?.('location');
      if (!REDIRECT_STATUSES.has(response?.status) || !location) {
        return response;
      }
      if (hop >= MAX_REDIRECTS) {
        throw new TypeError('fetch failed: too many redirects');
      }
      const target = new URL(String(location), url).toString();
      const status = response.status as number;
      // 303, and 301/302 after a POST, continue as GET without a body (fetch spec).
      const toGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
      if (toGet) method = 'GET';
      await checkOutboundRequest(method, target);
      try { await response.body?.cancel?.(); } catch { /* already consumed */ }
      const carried: Record<string, unknown> = { ...(nextInit || {}), method, redirect: 'manual' };
      if (toGet) delete carried.body;
      if (new URL(target).origin !== new URL(url).origin && carried.headers) {
        // Never forward credentials to another origin.
        carried.headers = withoutCredentials(carried.headers);
      }
      url = target;
      nextInput = target;
      nextInit = carried;
    }
  };
}

/** Wrap globalThis.fetch with the checks. Safe to call twice. */
export function patchOutboundFetch(): boolean {
  const s = state();
  if (s.patched) return true;
  const host = globalThis as any;
  if (typeof host.fetch !== 'function') return false;
  s.originalFetch = host.fetch;
  host.fetch = guardFetch(host.fetch);
  s.patched = true;
  return true;
}

export function _unpatchOutboundFetchForTests(): void {
  const s = state();
  if (s.patched) (globalThis as any).fetch = s.originalFetch;
  s.patched = false;
  s.enabled = undefined;
}
