/**
 * Internal runtime policy checks against the Traccia platform.
 */

import axios, { AxiosInstance } from 'axios';
import { loadConfig } from '../config/config';
import { govConfig } from './config';

const DEFAULT_STATUS_PATH = '/api/v1/agents/{agent_id}/status';
const DEFAULT_BLOCK_PATH = '/api/v1/agents/{agent_id}/blocks';

export class AgentBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentBlockedError';
  }
}

interface CacheEntry {
  timestamp: number;
  status: string;
  policyId?: string;
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

  set(key: string, status: string, policyId?: string): void {
    this.cache.set(key, { timestamp: Date.now(), status, policyId });
  }
}

const statusCache = new AgentStatusCache();
const inflight = new Map<string, Promise<void>>();
let httpClient: AxiosInstance = axios.create({ timeout: 5000 });

export function _setHttpClientForTests(client: AxiosInstance): void {
  httpClient = client;
}

export function _resetPolicyStateForTests(): void {
  statusCache.clear();
  inflight.clear();
  govConfig.statusCheckEndpoint = undefined;
  govConfig.postBlockEndpoint = undefined;
  govConfig.statusCacheTtlSeconds = 60;
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
  } else if (status !== 'allowed') {
    console.warn(
      `[traccia.governance] Unknown agent status received: ${status}. Treating as allowed.`,
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

async function fetchAndApplyStatus(agentId: string, failOpen: boolean): Promise<void> {
  const config = loadConfig();
  const apiKey = config.tracing.api_key;
  if (!apiKey) {
    console.warn(
      '[traccia.governance] Traccia API key not found. govern() requires a Traccia platform account; use observe() for tracing-only setups.',
    );
    return;
  }

  const tracesEndpoint = config.tracing.endpoint;
  if (!tracesEndpoint) {
    console.warn(
      '[traccia.governance] Traccia endpoint not found. govern() requires a Traccia platform endpoint; use observe() for tracing-only setups.',
    );
    return;
  }

  const baseUrl = deriveBaseUrl(tracesEndpoint);
  const url = statusUrl(baseUrl, agentId);

  let response;
  try {
    response = await httpClient.get(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 5000,
    });
  } catch (err) {
    if (failOpen) {
      console.warn(
        '[traccia.governance] Error fetching agent status from Traccia API:',
        err,
        'Allowing execution (failOpen).',
      );
      return;
    }
    throw new AgentBlockedError(
      `Failed to verify agent status and failOpen is false. Error: ${String(err)}`,
    );
  }

  if (response.status !== 200) {
    const message = `Failed to fetch agent status from Traccia (HTTP ${response.status}).`;
    if (failOpen) {
      console.warn(`[traccia.governance] ${message} Allowing execution (failOpen).`);
      return;
    }
    throw new AgentBlockedError(`${message} Blocking execution because failOpen is false.`);
  }

  const statusData = response.data as { status?: string; policy_id?: string };
  const status = statusData.status || 'allowed';
  const policyId = statusData.policy_id;

  statusCache.set(agentId, status, policyId);

  if ((status === 'soft_block' || status === 'hard_block') && policyId) {
    recordBlockAsync(blockUrl(baseUrl, agentId), apiKey, status, policyId);
  }

  handleStatus(status, agentId);
}

/**
 * Verify agent status with the Traccia platform before execution.
 *
 * Requires a Traccia API key and endpoint. Tracing-only users should use observe().
 */
export async function checkAgentStatus(
  agentId: string,
  options: { failOpen?: boolean } = {},
): Promise<void> {
  const failOpen = options.failOpen ?? true;
  statusCache.ttlSeconds = govConfig.statusCacheTtlSeconds;

  const cached = statusCache.get(agentId);
  if (cached) {
    handleStatus(cached.status, agentId);
    return;
  }

  let inflightPromise = inflight.get(agentId);
  if (!inflightPromise) {
    inflightPromise = fetchAndApplyStatus(agentId, failOpen).finally(() => {
      inflight.delete(agentId);
    });
    inflight.set(agentId, inflightPromise);
  }

  await inflightPromise;
}
