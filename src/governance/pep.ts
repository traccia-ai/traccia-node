/**
 * SDK policy enforcement point: check() on LLM and tool calls under govern().
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { resolveClientCredentials } from '../config/client-config';
import { getAgentId, getConfig, pepEnabled } from '../config/runtime-config';
import { getCurrentSpan } from '../context/context';
import {
  lastReads,
  MAX_READS_PER_SCOPE,
  promptByTrace,
  ReadEvidence,
  retrievalByTrace,
  runKey,
  spanLocalRootId,
  traceKey,
} from './evidence';
import { govConfig } from './config';
import * as failMode from './fail-mode';
import { AgentBlockedError, ApprovalPending, GovernanceConfigError, rejectedError } from './policy';

const CHECK_PATH = '/api/v1/policy/check';
const DECISION_EFFECTS = ['allow', 'warn', 'reshape', 'queue', 'deny'];
const SETTLE_PATH = '/api/v1/policy/settle';
const BUDGET_TTL_MS = 5000;

let httpClient: AxiosInstance = axios.create({ timeout: 2000 });
const remainingBudget = new Map<string, { ts: number; value: number }>();

export function _setPepHttpClientForTests(client: AxiosInstance): void {
  httpClient = client;
}

export function _resetPepStateForTests(): void {
  failMode._clearFailModeStateForTests();
  govConfig.policyFailMode = undefined;
  remainingBudget.clear();
  lastReads.clear();
  retrievalByTrace.clear();
  promptByTrace.clear();
  httpClient = axios.create({ timeout: 2000 });
}

/**
 * The customer a tool call reads or writes, when its arguments or result name one.
 * Only customer identity counts. A generic `id` (a policy or document id) does not
 * make a read customer-specific, so tool-level reads always reach the guard.
 */
function resourceId(row: unknown): string | undefined {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  const customer = customerId(record);
  if (customer) {
    return customer;
  }
  const value = record.customer_id;
  if (value != null && value !== '' && typeof value !== 'object') {
    return String(value);
  }
  return undefined;
}

function resolveLocalRootId(traceId: unknown, explicitRootId?: unknown): string | undefined {
  if (explicitRootId != null && explicitRootId !== '') {
    return String(explicitRootId);
  }
  const current = getCurrentSpan();
  if (current && traceKey(current.context?.traceId) === traceKey(traceId)) {
    return spanLocalRootId(current);
  }
  return undefined;
}

/** Freshness evidence belongs to one tenant, agent and run. */
function readScope(): { key: string; traceId: string } | undefined {
  const span = getCurrentSpan();
  const traceId = runKey(span?.context?.traceId, spanLocalRootId(span));
  if (!traceId) {
    return undefined;
  }
  const agentId = getAgentId() || process.env.TRACCIA_AGENT_ID || '';
  const tenantId = getConfig().tenantId || '';
  return { key: JSON.stringify([tenantId, agentId, traceId]), traceId };
}

export function rememberToolResult(name: string, result: unknown, args?: unknown): void {
  if (!name || !result || typeof result !== 'object' || Array.isArray(result)) {
    return;
  }
  const scope = readScope();
  if (!scope) {
    return;
  }
  const row = result as Record<string, unknown>;
  for (const field of ['as_of', 'updated_at'] as const) {
    const value = row[field];
    if (value != null && value !== '') {
      const entry: ReadEvidence = { tool: name, read_at: String(value), field };
      const resource = resourceId(args) || resourceId(row);
      if (resource) {
        entry.resource_id = resource;
      }
      lastReads.update(scope.key, scope.traceId, (current) => {
        const reads = new Map(current);
        const key = JSON.stringify([name, resource ?? null]);
        reads.delete(key);
        reads.set(key, entry);
        while (reads.size > MAX_READS_PER_SCOPE) {
          reads.delete(reads.keys().next().value as string);
        }
        return reads;
      });
      return;
    }
  }
}

export function noteRetrievalAttributes(
  traceId: string | undefined,
  attributes: Record<string, unknown> | undefined,
  localRootSpanId?: string,
): void {
  const key = runKey(traceId, resolveLocalRootId(traceId, localRootSpanId));
  if (!key || !attributes) {
    return;
  }
  const chunk = attributes['traccia.retrieval.chunk_count'];
  const presentFlag = attributes['traccia.retrieval.present'];
  if (chunk == null && presentFlag == null) {
    return;
  }
  retrievalByTrace.update(key, key, (current) => {
    const entry = { ...(current || {}) };
    if (presentFlag === true || chunk != null) {
      entry.present = true;
    }
    if (chunk != null) {
      entry.chunk_count = chunk;
    }
    return entry;
  });
}

/** Reads from this run only, newest first; skip reads of a different entity than the one being written. */
function freshnessContext(resource?: string): Array<Record<string, string>> {
  const scope = readScope();
  if (!scope) {
    return [];
  }
  const reads = Array.from(lastReads.get(scope.key)?.values() || []).reverse();
  return reads
    .filter((item) => !(resource && item.resource_id && item.resource_id !== resource))
    .map((item) => ({ ...item }) as Record<string, string>);
}

function retrievalContext(traceId: string | undefined, localRootSpanId?: string): Record<string, unknown> {
  const key = runKey(traceId, resolveLocalRootId(traceId, localRootSpanId));
  if (!key) {
    return { present: false };
  }
  const found = retrievalByTrace.get(key);
  if (!found) {
    return { present: false };
  }
  const out: Record<string, unknown> = { present: Boolean(found.present) };
  if (found.chunk_count != null) {
    out.chunk_count = found.chunk_count;
  }
  return out;
}

export function notePromptAttributes(
  traceId: unknown,
  attributes?: Record<string, unknown> | null,
  localRootSpanId?: string,
): void {
  if (!attributes) {
    return;
  }
  const name = attributes['traccia.prompt.name'];
  if (!name) {
    return;
  }
  const key = runKey(traceId, resolveLocalRootId(traceId, localRootSpanId));
  if (!key) {
    return;
  }
  const entry: { name: string; label?: unknown; version_id?: unknown } = { name: String(name) };
  if (attributes['traccia.prompt.label']) entry.label = attributes['traccia.prompt.label'];
  if (attributes['traccia.prompt.version_id']) entry.version_id = attributes['traccia.prompt.version_id'];
  promptByTrace.update(key, key, () => entry);
}

function promptFromAttributes(attributes?: Record<string, unknown> | null): Record<string, unknown> {
  if (!attributes) {
    return {};
  }
  const prompt: Record<string, unknown> = {};
  if (attributes['traccia.prompt.name']) prompt.name = attributes['traccia.prompt.name'];
  if (attributes['traccia.prompt.label']) prompt.label = attributes['traccia.prompt.label'];
  if (attributes['traccia.prompt.version_id']) prompt.version_id = attributes['traccia.prompt.version_id'];
  return prompt;
}

function promptContext(): Record<string, unknown> {
  const span = getCurrentSpan();
  const fromSpan = promptFromAttributes(span?.attributes as Record<string, unknown> | undefined);
  if (fromSpan.name) {
    return fromSpan;
  }
  const traceId = runKey(span?.context?.traceId, spanLocalRootId(span));
  if (!traceId) {
    return fromSpan;
  }
  const remembered = promptByTrace.get(traceId);
  if (!remembered) {
    return fromSpan;
  }
  const prompt: Record<string, unknown> = { name: remembered.name };
  if (remembered.label) prompt.label = remembered.label;
  if (remembered.version_id) prompt.version_id = remembered.version_id;
  return prompt;
}

function customerId(args: Record<string, unknown>): string | undefined {
  const customer = args.customer;
  if (customer && typeof customer === 'object' && !Array.isArray(customer)) {
    const id = (customer as Record<string, unknown>).id;
    if (id != null && id !== '') {
      return String(id);
    }
  }
  return undefined;
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
  const activation = decision.activation;
  if (activation === 'observe' || activation === 'warn' || activation === 'block') {
    span.setAttribute('traccia.policy.activation', String(activation));
  }
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

/** Accept only a decision the SDK can act on; anything else counts as no answer. */
export function validDecision(decision: unknown): decision is Record<string, unknown> {
  return (
    failMode.validFields(decision) &&
    DECISION_EFFECTS.includes(decision.effect as string) &&
    typeof decision.would_have === 'boolean'
  );
}

/**
 * No decision from Traccia: apply the fail mode (TRC-342). A rejection of the key
 * after this check was sent wins over any fail mode.
 */
function unresolved(ident: string, startedAt: number, reason: string, detail: string): Record<string, unknown> {
  const rejected = failMode.rejectedSince(ident, startedAt);
  if (rejected) {
    throw rejectedError(rejected);
  }
  if (failMode.resolve(ident, failMode.localMode()) === 'closed') {
    console.error(
      `[traccia.governance] policy check could not complete (${detail}); blocking call (policy fail mode: closed)`,
    );
    throw new AgentBlockedError(
      `Policy check could not complete (${detail}). Blocking because the policy fail mode is closed.`,
      { reasons: [reason] },
    );
  }
  console.warn(
    `[traccia.governance] policy check could not complete (${detail}); allowing call (policy fail mode: open)`,
  );
  return { effect: 'allow', would_have: false, reasons: [reason] };
}

export async function checkPolicy(input: {
  action: Record<string, unknown>;
  context?: Record<string, unknown>;
  resource?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { apiKey, endpoint } = resolveClientCredentials();
  if (!apiKey || !endpoint) {
    throw new GovernanceConfigError(
      'Traccia API key or endpoint not set. Policy checks need both (TRACCIA_API_KEY and TRACCIA_ENDPOINT, or init()).',
    );
  }
  const agentId = getAgentId() || process.env.TRACCIA_AGENT_ID;
  if (!agentId) {
    throw new GovernanceConfigError('No agentId on init, govern(), or TRACCIA_AGENT_ID. Policy checks need one.');
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
  const base = deriveBaseUrl(endpoint);
  const ident = failMode.identity(apiKey, base);
  const startedAt = failMode.now();
  let response: AxiosResponse<unknown>;
  try {
    response = await httpClient.post(`${base}${CHECK_PATH}`, payload, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status !== undefined && failMode.REJECT_STATUSES.includes(status)) {
      failMode.noteRejection(ident, status);
      throw rejectedError(status);
    }
    if (status !== undefined) {
      return unresolved(ident, startedAt, 'check_http_error', `HTTP ${status}`);
    }
    return unresolved(ident, startedAt, 'check_error', error instanceof Error ? error.message : String(error));
  }
  if (failMode.REJECT_STATUSES.includes(response.status)) {
    failMode.noteRejection(ident, response.status);
    throw rejectedError(response.status);
  }
  if (response.status !== 200) {
    return unresolved(ident, startedAt, 'check_http_error', `HTTP ${response.status}`);
  }
  const decision = response.data;
  if (!validDecision(decision)) {
    return unresolved(ident, startedAt, 'check_error', 'invalid decision');
  }
  const rejected = failMode.rejectedSince(ident, startedAt);
  if (rejected) {
    // The key was rejected while this check was on its way: its answer, even an
    // allow, no longer holds.
    throw rejectedError(rejected);
  }
  failMode.noteAnswer(ident, decision, startedAt);
  cacheBudget(agentId, decision.remaining_budget_usd);
  stampSpan(decision);
  if (decision.would_have) {
    return decision;
  }
  if (decision.effect === 'queue') {
    throw new ApprovalPending('This action is waiting for approval. Do not run the tool or retry the check.', {
      approvalId: decision.approval_id as string | undefined,
      expiresAt: decision.approval_expires_at as string | undefined,
      decisionId: decision.id as string | undefined,
    });
  }
  if (decision.effect === 'deny') {
    throw new AgentBlockedError(blockedMessage(decision), {
      decisionId: decision.id as string | undefined,
      remainingBudgetUsd: decision.remaining_budget_usd as number | null,
      reasons: (decision.reasons as string[]) || [],
    });
  }
  return decision;
}

export async function settlePolicy(
  decision: Record<string, unknown> | undefined,
  opts: { release?: boolean; actualUsd?: number } = {},
): Promise<void> {
  const reserved = (decision?.obligations as Record<string, unknown> | undefined)?.reserved_usd;
  if (reserved == null) {
    return;
  }
  const { apiKey, endpoint } = resolveClientCredentials();
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

/** Where this provider API takes the output-token cap: [params, key]. */
function tokenCap(
  kwargs: Record<string, unknown>,
  vendor?: string,
  api?: string,
): [Record<string, unknown>, string] {
  if (vendor === 'google_gemini') {
    return [(kwargs.generation_config as Record<string, unknown>) ?? {}, 'max_output_tokens'];
  }
  if (api === 'responses') {
    return [kwargs, 'max_output_tokens'];
  }
  if (vendor === 'anthropic') {
    return [kwargs, 'max_tokens'];
  }
  const key = ['max_completion_tokens', 'max_tokens'].find((k) => kwargs[k] != null);
  // OpenAI reasoning models reject max_tokens; every Chat model takes max_completion_tokens.
  return [kwargs, key ?? (vendor === 'openai' ? 'max_completion_tokens' : 'max_tokens')];
}

/**
 * Check policy before an LLM call. `vendor` is the span's llm.vendor; Spend Cap uses it to pick that provider's price.
 * `api` is the span's llm.api ('responses' for the OpenAI Responses API); with `vendor` it picks the token-cap parameter.
 */
export async function enforceLlmCall(
  kwargs: Record<string, unknown>,
  vendor?: string,
  api?: string,
): Promise<Record<string, unknown> | undefined> {
  if (!pepEnabled()) {
    return undefined;
  }
  const model = kwargs.model;
  const [capParams, capKey] = tokenCap(kwargs, vendor, api);
  const span = getCurrentSpan();
  const traceId = asOtelHex(span?.context?.traceId, 32);
  const localRootId = spanLocalRootId(span);
  const context: Record<string, unknown> = {
    model,
    max_tokens: capParams[capKey],
    input_tokens: estimateTokens(kwargs),
    retrieval: retrievalContext(traceId, localRootId),
  };
  if (vendor) {
    context.vendor = vendor;
  }
  const prompt = promptContext();
  if (Object.keys(prompt).length) {
    context.prompt = prompt;
  }
  const decision = await checkPolicy({
    action: { type: 'llm_call', name: 'llm_call', model },
    context,
  });
  if (decision.effect === 'reshape' && !decision.would_have) {
    const obligations = (decision.obligations as Record<string, unknown>) || {};
    const cheaper = obligations.cheaper_model || obligations.fallback_model;
    if (cheaper) {
      kwargs.model = cheaper;
    }
    if (obligations.clamp_max_tokens != null) {
      if (capParams === kwargs) {
        kwargs[capKey] = obligations.clamp_max_tokens;
      } else {
        kwargs.generation_config = { ...capParams, [capKey]: obligations.clamp_max_tokens };
      }
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
  const context: Record<string, unknown> = { input: args, tool_name: name };
  const freshness = freshnessContext(resourceId(args));
  if (freshness.length) {
    context.freshness = freshness;
  }
  const id = customerId(args);
  if (id) {
    context.customer_id = id;
  }
  return checkPolicy({
    action: { type: 'tool_call', name },
    context,
  });
}
