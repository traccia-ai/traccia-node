/**
 * SDK policy enforcement point: check() on LLM and tool calls under govern().
 */

import axios, { AxiosInstance } from 'axios';
import { loadConfig } from '../config/config';
import { getAgentId, pepEnabled } from '../config/runtime-config';
import { getCurrentSpan } from '../context/context';
import { AgentBlockedError } from './policy';

const CHECK_PATH = '/api/v1/policy/check';
const SETTLE_PATH = '/api/v1/policy/settle';
const BUDGET_TTL_MS = 5000;

let httpClient: AxiosInstance = axios.create({ timeout: 2000 });
const remainingBudget = new Map<string, { ts: number; value: number }>();

export function _setPepHttpClientForTests(client: AxiosInstance): void {
  httpClient = client;
}

export function _resetPepStateForTests(): void {
  remainingBudget.clear();
  httpClient = axios.create({ timeout: 2000 });
}

function asOtelHex(value: unknown, width: number): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'bigint') {
    return value.toString(16).padStart(width, '0');
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value.toString(16).padStart(width, '0');
  }
  const text = String(value).trim();
  return text || undefined;
}

export function _asOtelHexForTests(value: unknown, width: number): string | undefined {
  return asOtelHex(value, width);
}

function deriveBaseUrl(tracesEndpoint: string): string {
  const url = new URL(tracesEndpoint);
  return `${url.protocol}//${url.host}`;
}

function stampSpan(decision: Record<string, unknown>): void {
  const span = getCurrentSpan();
  if (!span) {
    return;
  }
  if (decision.id) {
    span.setAttribute('traccia.policy.decision_id', String(decision.id));
  }
  if (decision.effect) {
    span.setAttribute('traccia.policy.effect', String(decision.effect));
  }
  span.setAttribute('traccia.policy.would_have', Boolean(decision.would_have));
  const ids = decision.policy_ids as string[] | undefined;
  if (ids && ids.length) {
    span.setAttribute('traccia.policy.ids', ids.join(','));
  }
  const reasons = decision.reasons as string[] | undefined;
  if (reasons && reasons[0]) {
    span.setAttribute('traccia.policy.reason', String(reasons[0]).slice(0, 500));
  }
}

function cacheBudget(agentId: string, remaining: unknown): void {
  if (typeof remaining !== 'number') {
    return;
  }
  remainingBudget.set(agentId, { ts: Date.now(), value: remaining });
}

export function cachedRemainingBudget(agentId: string): number | undefined {
  const entry = remainingBudget.get(agentId);
  if (!entry || Date.now() - entry.ts > BUDGET_TTL_MS) {
    remainingBudget.delete(agentId);
    return undefined;
  }
  return entry.value;
}

function blockedMessage(decision: Record<string, unknown>): string {
  const reasons = (decision.reasons as string[]) || [];
  const parts = [reasons[0] || 'policy denied this call'];
  if (typeof decision.remaining_budget_usd === 'number') {
    parts.push(`remaining budget $${decision.remaining_budget_usd.toFixed(2)}`);
  }
  if (decision.id) {
    parts.push(`decision ${decision.id}`);
  }
  return parts.join('. ');
}

export async function checkPolicy(input: {
  action: Record<string, unknown>;
  context?: Record<string, unknown>;
  resource?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const apiKey = config.tracing.api_key || process.env.TRACCIA_API_KEY;
  const endpoint = config.tracing.endpoint || process.env.TRACCIA_ENDPOINT;
  if (!apiKey || !endpoint) {
    return { effect: 'allow', would_have: false, reasons: ['missing_credentials'] };
  }
  const agentId = getAgentId() || process.env.TRACCIA_AGENT_ID;
  if (!agentId) {
    return { effect: 'allow', would_have: false, reasons: ['missing_agent_id'] };
  }
  const span = getCurrentSpan();
  const payload = {
    principal: { agent_id: agentId },
    action: input.action,
    resource: input.resource || {},
    context: { ...(input.context || {}), agent_id: agentId },
    agent_id: agentId,
    trace_id: asOtelHex(span?.context?.traceId, 32),
    span_id: asOtelHex(span?.context?.spanId, 16),
  };
  const remaining = cachedRemainingBudget(agentId);
  if (remaining !== undefined) {
    (payload.context as Record<string, unknown>).remaining_budget_usd = remaining;
  }
  try {
    const base = deriveBaseUrl(endpoint);
    const response = await httpClient.post(`${base}${CHECK_PATH}`, payload, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const decision = response.data as Record<string, unknown>;
    cacheBudget(agentId, decision.remaining_budget_usd);
    stampSpan(decision);
    if (decision.would_have) {
      return decision;
    }
    if (decision.effect === 'deny') {
      throw new AgentBlockedError(blockedMessage(decision), {
        decisionId: decision.id as string | undefined,
        remainingBudgetUsd: decision.remaining_budget_usd as number | null,
        reasons: (decision.reasons as string[]) || [],
      });
    }
    return decision;
  } catch (error) {
    if (error instanceof AgentBlockedError) {
      throw error;
    }
    if (axios.isAxiosError(error) && error.response) {
      console.warn(
        '[traccia.governance] policy check HTTP',
        error.response.status,
        '; allowing call',
      );
      return { effect: 'allow', would_have: false, reasons: ['check_http_error'] };
    }
    console.warn('[traccia.governance] policy check failed; allowing call', error);
    return { effect: 'allow', would_have: false, reasons: ['check_error'] };
  }
}

export async function settlePolicy(
  decision: Record<string, unknown> | undefined,
  opts: { release?: boolean; actualUsd?: number } = {},
): Promise<void> {
  const reserved = (decision?.obligations as Record<string, unknown> | undefined)?.reserved_usd;
  if (reserved == null) {
    return;
  }
  const config = loadConfig();
  const apiKey = config.tracing.api_key || process.env.TRACCIA_API_KEY;
  const endpoint = config.tracing.endpoint || process.env.TRACCIA_ENDPOINT;
  const agentId = getAgentId() || process.env.TRACCIA_AGENT_ID;
  if (!apiKey || !endpoint || !agentId) {
    return;
  }
  const span = getCurrentSpan();
  try {
    const base = deriveBaseUrl(endpoint);
    await httpClient.post(
      `${base}${SETTLE_PATH}`,
      {
        agent_id: agentId,
        trace_id: asOtelHex(span?.context?.traceId, 32),
        reserved_usd: reserved,
        actual_usd: opts.actualUsd,
        release: Boolean(opts.release),
      },
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
  } catch {
    // settle is best-effort
  }
}

function estimateTokens(kwargs: Record<string, unknown>): number | undefined {
  const messages = kwargs.messages as Array<{ content?: unknown }> | undefined;
  let blob = '';
  if (Array.isArray(messages)) {
    blob = messages.map((item) => String(item?.content || '')).join('\n');
  } else if (typeof kwargs.prompt === 'string') {
    blob = kwargs.prompt;
  } else if (typeof kwargs.input === 'string') {
    blob = kwargs.input;
  }
  if (!blob) {
    return undefined;
  }
  return Math.max(Math.floor(blob.length / 4), 1);
}

export async function enforceLlmCall(kwargs: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  if (!pepEnabled()) {
    return undefined;
  }
  const model = kwargs.model;
  const decision = await checkPolicy({
    action: { type: 'llm_call', name: 'llm_call', model },
    context: {
      model,
      max_tokens: kwargs.max_tokens || kwargs.max_completion_tokens,
      input_tokens: estimateTokens(kwargs),
    },
  });
  if (decision.effect === 'reshape' && !decision.would_have) {
    const obligations = (decision.obligations as Record<string, unknown>) || {};
    const cheaper = obligations.cheaper_model || obligations.fallback_model;
    if (cheaper) {
      kwargs.model = cheaper;
    }
    if (obligations.clamp_max_tokens != null) {
      kwargs.max_tokens = obligations.clamp_max_tokens;
    }
  }
  return decision;
}

export async function finishLlmCall(
  decision: Record<string, unknown> | undefined,
  opts: { release?: boolean; actualUsd?: number } = {},
): Promise<void> {
  await settlePolicy(decision, opts);
}

export async function enforceToolCall(
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown> | undefined> {
  if (!pepEnabled()) {
    return undefined;
  }
  return checkPolicy({
    action: { type: 'tool_call', name },
    context: { input: args, tool_name: name },
  });
}
