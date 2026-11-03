/**
 * What policy checks do when Traccia gives no answer (TRC-342).
 *
 * The customer chooses in Traccia (Settings -> Policy Enforcement): block the call
 * ('closed', the default) or let it through ('open'). The setting arrives on answers
 * the SDK already gets, the agent-status answer at the start of a govern() run and
 * each policy-check answer, as `fail_mode` and `fail_mode_version`. It is kept per
 * API key and endpoint for `failModeSettings.ttlMs` after the last answer that carried it.
 *
 * A local override (`init({ policyFailMode })`, or `govern({ policyFailMode })` for
 * one run) replaces the customer's setting, but only when Traccia gives no answer:
 * it never overrides a 401/403, a block, a deny or a configuration error.
 */

import { createHash } from 'crypto';
import { pepFailMode } from '../config/runtime-config';
import { govConfig } from './config';

export type PolicyFailMode = 'open' | 'closed';

export const FAIL_MODES: readonly PolicyFailMode[] = ['open', 'closed'];
export const DEFAULT_FAIL_MODE: PolicyFailMode = 'closed';
export const REJECT_STATUSES: readonly number[] = [401, 403];

interface Entry {
  mode: PolicyFailMode | null;
  expiresAt: number;
  version: number;
  /** Set on a 401/403: an answer to a request sent before it is refused. */
  rejectedAt: number;
  rejectedStatus: number;
}

interface SharedFailModeState {
  /** ttlMs matches the gateway's default (GATEWAY_POLICY_FAIL_MODE_CACHE_S = 600). */
  settings: { ttlMs: number; cacheMax: number };
  /** Insertion-ordered: the oldest entry is evicted first. */
  state: Map<string, Entry>;
  warned: Set<string>;
}

const FAIL_MODE_STATE_KEY = Symbol.for('traccia.policyFailModeState');

/**
 * One process shares the setting across the separately bundled entry points (auto,
 * index, cli): a status answer seen by one copy must apply to checks made by another.
 */
const host = globalThis as typeof globalThis & { [FAIL_MODE_STATE_KEY]?: SharedFailModeState };
const shared = (host[FAIL_MODE_STATE_KEY] ??= {
  settings: { ttlMs: 600_000, cacheMax: 10_000 },
  state: new Map<string, Entry>(),
  warned: new Set<string>(),
});
const state = shared.state;
const warned = shared.warned;
export const failModeSettings = shared.settings;

export function now(): number {
  return performance.now();
}

/** Whose setting this is: the API key (hashed) at that Traccia endpoint. */
export function identity(apiKey: string, endpoint: string): string {
  return `${createHash('sha256').update(apiKey).digest('hex')}|${endpoint}`;
}

export function validateMode(value: unknown, name = 'policyFailMode'): PolicyFailMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'open' || value === 'closed') return value;
  throw new Error(`${name} must be 'open', 'closed' or undefined, not ${JSON.stringify(value)}`);
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Fields that are present must be valid. Absent fields are fine (unknown). */
export function validFields(answer: unknown): answer is Record<string, unknown> {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
  const a = answer as Record<string, unknown>;
  if ('fail_mode' in a && a.fail_mode !== null && !FAIL_MODES.includes(a.fail_mode as PolicyFailMode)) {
    return false;
  }
  return !('fail_mode_version' in a) || isVersion(a.fail_mode_version);
}

function store(key: string, entry: Entry): void {
  state.delete(key);
  state.set(key, entry);
  while (state.size > failModeSettings.cacheMax) {
    state.delete(state.keys().next().value as string);
  }
}

/**
 * Keep the setting from a server answer to a request sent at startedAt.
 *
 * Both fields must be present: a missing one means the server could not read the
 * setting, and what is held stays. `fail_mode: null` with a version clears it.
 */
export function noteAnswer(ident: string, answer: Record<string, unknown>, startedAt: number): void {
  if (!('fail_mode' in answer) || !('fail_mode_version' in answer) || !validFields(answer)) return;
  const mode = answer.fail_mode as PolicyFailMode | null;
  const version = answer.fail_mode_version as number;
  const held = state.get(ident);
  if (held && (startedAt < held.rejectedAt || version < held.version)) return;
  store(ident, {
    mode,
    expiresAt: now() + failModeSettings.ttlMs,
    version,
    rejectedAt: held?.rejectedAt ?? 0,
    rejectedStatus: held?.rejectedStatus ?? 0,
  });
}

/** The key was refused: drop its setting and refuse requests already on their way. */
export function noteRejection(ident: string, status: number): void {
  const at = now();
  const held = state.get(ident);
  store(ident, {
    mode: null,
    expiresAt: at + failModeSettings.ttlMs,
    version: held?.version ?? 0,
    rejectedAt: at,
    rejectedStatus: status,
  });
}

/** The 401/403 status if the key was refused after a request sent at startedAt. */
export function rejectedSince(ident: string, startedAt: number): number | undefined {
  const held = state.get(ident);
  return held && held.rejectedAt > startedAt ? held.rejectedStatus : undefined;
}

/** The customer's setting from Traccia, or null (unset, unknown or expired). */
export function customerMode(ident: string): PolicyFailMode | null {
  const held = state.get(ident);
  if (held && held.expiresAt > now()) return held.mode;
  state.delete(ident);
  return null;
}

/** The local override: this govern() run's, else init's, else undefined. */
export function localMode(): PolicyFailMode | undefined {
  return pepFailMode() ?? govConfig.policyFailMode;
}

/** The mode to apply when Traccia gives no answer. */
export function resolve(ident: string, local: PolicyFailMode | undefined): PolicyFailMode {
  const traccia = customerMode(ident) ?? DEFAULT_FAIL_MODE;
  if (local === undefined) return traccia;
  if (local !== traccia && !warned.has(`${ident}|${local}`)) {
    warned.add(`${ident}|${local}`);
    console.warn(
      `[traccia.governance] policyFailMode '${local}' overrides your Traccia setting ('${traccia}') ` +
        'in this process. The Traccia Gateway follows the Traccia setting.',
    );
  }
  return local;
}

/**
 * Forget remembered settings (a new init()), but keep each key's rejection: a
 * request sent before a 401/403 must stay refused even if init() runs while it is
 * on its way. Requests sent after the rejection are unaffected.
 */
export function resetFailModeState(): void {
  for (const [key, held] of [...state]) {
    if (held.rejectedAt) {
      state.set(key, { ...held, mode: null, version: 0 });
    } else {
      state.delete(key);
    }
  }
  warned.clear();
}

export function _clearFailModeStateForTests(): void {
  state.clear();
  warned.clear();
}

export function _failModeStateSizeForTests(): number {
  return state.size;
}
