/**
 * Internal runtime policy checks against the Traccia platform.
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { createHash } from 'crypto';
import { resolveClientCredentials } from '../config/client-config';
import { govConfig } from './config';
import * as failMode from './fail-mode';
import type { PolicyFailMode } from './fail-mode';

const DEFAULT_STATUS_PATH = '/api/v1/agents/{agent_id}/status';
const DEFAULT_BLOCK_PATH = '/api/v1/agents/{agent_id}/blocks';
const AGENT_STATUSES = ['allowed', 'soft_block', 'hard_block'];

export class ApprovalPending extends Error {
  approvalId?: string;
  expiresAt?: string;
  decisionId?: string;

  constructor(
    message: string,
    extras?: { approvalId?: string; expiresAt?: string; decisionId?: string },
  ) {
    super(message);
    this.name = 'ApprovalPending';
    this.approvalId = extras?.approvalId;
    this.expiresAt = extras?.expiresAt;
    this.decisionId = extras?.decisionId;
  }
}

/** A normal tool result for frameworks that retry raised errors. Do not call the tool again. */
export function pendingToolResult(error: ApprovalPending): {
  status: 'pending_approval';
  approval_id?: string;
  expires_at?: string;
} {
  return {
    status: 'pending_approval',
    approval_id: error.approvalId,
    expires_at: error.expiresAt,
  };
}

export class AgentBlockedError extends Error {
  decisionId?: string;
  remainingBudgetUsd?: number | null;
  reasons: string[];

  constructor(message: string, extras?: { decisionId?: string; remainingBudgetUsd?: number | null; reasons?: string[] }) {
    super(message);
    this.name = 'AgentBlockedError';
    this.decisionId = extras?.decisionId;
    this.remainingBudgetUsd = extras?.remainingBudgetUsd;
    this.reasons = extras?.reasons || [];
  }
}

/**
 * govern() or a policy check is missing its API key, endpoint or agent ID.
 * The call is blocked, whatever the fail mode: a misconfigured check never allows.
 */
export class GovernanceConfigError extends AgentBlockedError {
  constructor(message: string) {
    super(message, { reasons: ['configuration_error'] });
    this.name = 'GovernanceConfigError';
  }
}

export const REJECT_REASONS: Record<number, string> = { 401: 'invalid_api_key', 403: 'permission_denied' };

interface CacheEntry {
  timestamp: number;
  status: string;
  policyId?: string;
  /** When the request behind it was sent (fail-mode clock): a status fetched before the key was rejected no longer holds. */
  sentAt: number;
}

class AgentStatusCache {
  private cache = new Map<string, CacheEntry>();

  constructor(public ttlSeconds = 60) {}

  clear(): void {
    this.cache.clear();
  }

  get(key: string): { status: string; policyId?: string } | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.timestamp >= this.ttlSeconds * 1000) {
      this.cache.delete(key);
      return undefined;
    }
    return { status: entry.status, policyId: entry.policyId };
  }

  set(key: string, status: string, policyId?: string, sentAt: number = failMode.now()): void {
    this.cache.set(key, { timestamp: Date.now(), status, policyId, sentAt });
  }

  sentAt(key: string): number {
    return this.cache.get(key)?.sentAt ?? 0;
  }

  drop(key: string): void {
    this.cache.delete(key);
  }
}

const statusCache = new AgentStatusCache();
const inflight = new Map<string, Promise<StatusOutcome>>();
let httpClient: AxiosInstance = axios.create({ timeout: 5000 });

export function _setHttpClientForTests(client: AxiosInstance): void {
  httpClient = client;
}

/** Forget cached statuses only, so the next status check is a real request. */
export function _clearStatusCacheForTests(): void {
  statusCache.clear();
}

export function _resetPolicyStateForTests(): void {
  statusCache.clear();
  inflight.clear();
  govConfig.statusCheckEndpoint = undefined;
  govConfig.postBlockEndpoint = undefined;
  govConfig.statusCacheTtlSeconds = 60;
  govConfig.policyFailMode = undefined;
  failMode._clearFailModeStateForTests();
  httpClient = axios.create({ timeout: 5000 });
}

function deriveBaseUrl(tracesEndpoint: string): string {
  const url = new URL(tracesEndpoint);
  return `${url.protocol}//${url.host}`;
}

function statusUrl(baseUrl: string, agentId: string): string {
  if (govConfig.statusCheckEndpoint) {
    return govConfig.statusCheckEndpoint.replace('{agent_id}', agentId);
  }
  return `${baseUrl}${DEFAULT_STATUS_PATH.replace('{agent_id}', agentId)}`;
}

function blockUrl(baseUrl: string, agentId: string): string {
  if (govConfig.postBlockEndpoint) {
    return govConfig.postBlockEndpoint.replace('{agent_id}', agentId);
  }
  return `${baseUrl}${DEFAULT_BLOCK_PATH.replace('{agent_id}', agentId)}`;
}

function handleStatus(status: string, agentId: string): void {
  if (status === 'hard_block') {
    throw new AgentBlockedError(
      `Agent ${agentId} execution is hard blocked by governance policy.`,
    );
  }
  if (status === 'soft_block') {
    console.warn(
      `[traccia.governance] Agent ${agentId} is SOFT BLOCKED by governance policy. Execution continuing with warning.`,
    );
  }
}

function recordBlockAsync(
  url: string,
  apiKey: string,
  status: string,
  policyId: string,
): void {
  void httpClient
    .post(
      url,
      { policy_id: policyId, block_type: status },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 5000 },
    )
    .catch((err) => {
      console.warn('[traccia.governance] Failed to record agent block to Traccia API:', err);
    });
}

/** Traccia refused the API key. No fail mode or override applies. */
export function rejectedError(status: number): AgentBlockedError {
  return new AgentBlockedError(
    `Traccia rejected this API key (HTTP ${status}). Check TRACCIA_API_KEY and its workspace.`,
    { reasons: [REJECT_REASONS[status] ?? 'rejected'] },
  );
}

/** Status belongs to one API key and URL (endpoint and agent), never to the agent ID alone. */
function statusKey(apiKey: string, url: string): string {
  return `${createHash('sha256').update(apiKey).digest('hex')}|${url}`;
}

type StatusOutcome =
  | { outcome: 'ok'; answer: Record<string, unknown> }
  | { outcome: 'rejected'; status: number }
  | { outcome: 'unavailable'; detail: string };

function unanswered(ident: string, startedAt: number, detail: string): StatusOutcome {
  const rejected = failMode.rejectedSince(ident, startedAt);
  return rejected ? { outcome: 'rejected', status: rejected } : { outcome: 'unavailable', detail };
}

/**
 * One status request, shared by the callers that missed the cache. Never throws.
 *
 * Records the fail mode, a rejection, the cache entry and a block report once,
 * here; each caller then applies its own override to the outcome.
 */
async function fetchStatus(apiKey: string, baseUrl: string, url: string, agentId: string): Promise<StatusOutcome> {
  const ident = failMode.identity(apiKey, baseUrl);
  const startedAt = failMode.now();
  let response: AxiosResponse<unknown>;
  try {
    response = await httpClient.get(url, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 5000 });
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status !== undefined && failMode.REJECT_STATUSES.includes(status)) {
      failMode.noteRejection(ident, status);
      return { outcome: 'rejected', status };
    }
    return unanswered(ident, startedAt, status !== undefined ? `HTTP ${status}` : `error: ${String(err)}`);
  }
  if (failMode.REJECT_STATUSES.includes(response.status)) {
    failMode.noteRejection(ident, response.status);
    return { outcome: 'rejected', status: response.status };
  }
  if (response.status !== 200) {
    return unanswered(ident, startedAt, `HTTP ${response.status}`);
  }
  const answer = response.data;
  if (!failMode.validFields(answer) || !AGENT_STATUSES.includes(answer.status as string)) {
    return unanswered(ident, startedAt, 'invalid status answer');
  }
  const rejected = failMode.rejectedSince(ident, startedAt);
  if (rejected) {
    return { outcome: 'rejected', status: rejected };
  }
  failMode.noteAnswer(ident, answer, startedAt);

  const status = answer.status as string;
  const policyId = answer.policy_id as string | undefined;
  statusCache.set(statusKey(apiKey, url), status, policyId, startedAt);
  if ((status === 'soft_block' || status === 'hard_block') && policyId) {
    recordBlockAsync(blockUrl(baseUrl, agentId), apiKey, status, policyId);
  }
  return { outcome: 'ok', answer };
}

/** This run's override. failOpen is a deprecated alias: true = 'open', false = 'closed'. */
export function localFailMode(
  failOpen: boolean | undefined,
  policyFailMode: PolicyFailMode | undefined,
  caller: string,
): PolicyFailMode | undefined {
  const mode = failMode.validateMode(policyFailMode);
  if (failOpen === undefined) return mode;
  process.emitWarning(
    `${caller}({ failOpen }) is deprecated. Omit it to follow your Traccia setting ` +
      "(Settings -> Policy Enforcement), or pass policyFailMode: 'open' or 'closed'.",
    'DeprecationWarning',
  );
  const legacy: PolicyFailMode = failOpen ? 'open' : 'closed';
  if (mode !== undefined && mode !== legacy) {
    throw new Error(`${caller}({ failOpen: ${failOpen} }) conflicts with policyFailMode '${mode}'; pass only one.`);
  }
  return legacy;
}

/**
 * Verify agent status with the Traccia platform before execution.
 *
 * A hard block throws AgentBlockedError, whatever the fail mode. When Traccia gives
 * no answer, the fail mode applies: `policyFailMode` (this run's override), else
 * init's, else the customer's setting, else 'closed' (block). A missing API key or
 * endpoint throws GovernanceConfigError; use observe() for tracing only.
 * `failOpen` is deprecated (true = 'open', false = 'closed').
 */
export async function checkAgentStatus(
  agentId: string,
  options: { policyFailMode?: PolicyFailMode; failOpen?: boolean } = {},
): Promise<void> {
  const override = localFailMode(options.failOpen, options.policyFailMode, 'checkAgentStatus');
  const { apiKey, endpoint: tracesEndpoint } = resolveClientCredentials();
  if (!apiKey) {
    throw new GovernanceConfigError(
      'Traccia API key not found. govern() requires a Traccia platform account. ' +
        'Set TRACCIA_API_KEY, or use observe() for tracing only.',
    );
  }
  if (!tracesEndpoint) {
    throw new GovernanceConfigError(
      'Traccia endpoint not found. govern() requires a Traccia platform endpoint. ' +
        'Set TRACCIA_ENDPOINT, or use observe() for tracing only.',
    );
  }
  const baseUrl = deriveBaseUrl(tracesEndpoint);
  const url = statusUrl(baseUrl, agentId);
  const key = statusKey(apiKey, url);
  const ident = failMode.identity(apiKey, baseUrl);

  statusCache.ttlSeconds = govConfig.statusCacheTtlSeconds;
  let cached = statusCache.get(key);
  if (cached && failMode.rejectedSince(ident, statusCache.sentAt(key))) {
    // The key was rejected after this status was fetched, by any check for any
    // agent: it no longer holds. Ask again; a still-rejected key gets 401/403.
    statusCache.drop(key);
    cached = undefined;
  }
  if (cached) {
    // A cached status is not a new answer: it does not renew the fail mode.
    handleStatus(cached.status, agentId);
    return;
  }

  let inflightPromise = inflight.get(key);
  if (!inflightPromise) {
    inflightPromise = fetchStatus(apiKey, baseUrl, url, agentId).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, inflightPromise);
  }
  const result = await inflightPromise;

  if (result.outcome === 'rejected') {
    throw rejectedError(result.status);
  }
  if (result.outcome === 'unavailable') {
    const mode = failMode.resolve(ident, override ?? govConfig.policyFailMode);
    if (mode === 'open') {
      console.warn(
        `[traccia.governance] Could not verify agent status with Traccia (${result.detail}). ` +
          'Allowing execution (policy fail mode: open).',
      );
      return;
    }
    console.error(
      `[traccia.governance] Could not verify agent status with Traccia (${result.detail}). ` +
        'Blocking execution (policy fail mode: closed).',
    );
    throw new AgentBlockedError(
      `Could not verify agent status with Traccia (${result.detail}). Blocking because the policy fail mode is closed.`,
      { reasons: ['policy_unavailable'] },
    );
  }
  handleStatus(result.answer.status as string, agentId);
}
