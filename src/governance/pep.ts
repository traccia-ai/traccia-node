/**
 * SDK policy enforcement point: check() on LLM and tool calls under govern().
 */

import { createHmac } from 'crypto';
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
} from './evidence';
import { govConfig } from './config';
import * as failMode from './fail-mode';
import { ActiveCall, bindKey, deriveKey, isRunning, KEY_PATTERN, KEY_PREFIX, KeyType, Unkeyable, unkeyableFrom } from './idempotency-key';
import { isUnconfirmed } from './unconfirmed';
import { jsonSafe } from '../utils/json-safe';
import {
  AgentBlockedError,
  ApprovalPending,
  GovernanceConfigError,
  IDEMPOTENCY_DENY_REASONS,
  IDEMPOTENCY_IN_FLIGHT,
  IdempotencyDenyReason,
  IdempotencyRepeatError,
  rejectedError,
} from './policy';

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
  inFlightNow = () => Date.now();
  inFlightSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  inFlightJitter = jitteredDelay;
}

// A call denied because the same call is in flight waits and checks again: if the first call
// fails, this one runs instead of being lost; if it succeeds, this one gets the normal repeat.
// Delays double from 500 ms up to 4 s.
const IN_FLIGHT_FIRST_DELAY_MS = 500;
const IN_FLIGHT_MAX_DELAY_MS = 4000;
let inFlightNow: () => number = () => Date.now();
let inFlightSleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each re-check waits a random 50-150% of the step: callers waiting out the same in-flight call would
// otherwise re-check in lockstep (0.5, 1, 2, 4 s), hitting the server in waves during a burst.
// Exported for tests.
export function jitteredDelay(ms: number): number {
  return ms * (0.5 + Math.random());
}
let inFlightJitter: (ms: number) => number = jitteredDelay;

/** Fixed clock and sleep for tests; also turns jitter off so the delays are exact. */
export function _setInFlightClockForTests(now: () => number, sleep: (ms: number) => Promise<void>): void {
  inFlightNow = now;
  inFlightSleep = sleep;
  inFlightJitter = (ms) => ms;
}

async function checkWaitingInFlight<T>(check: (recheck: boolean) => Promise<T>, waitMs: number): Promise<T> {
  const deadline = inFlightNow() + waitMs;
  let delay = IN_FLIGHT_FIRST_DELAY_MS;
  let recheck = false;
  for (;;) {
    let pause: number;
    try {
      return await check(recheck);
    } catch (error) {
      const inFlight = error instanceof IdempotencyRepeatError && error.reason === IDEMPOTENCY_IN_FLIGHT;
      pause = inFlightJitter(delay);
      if (!inFlight || inFlightNow() + pause > deadline) throw error;
    }
    await inFlightSleep(pause);
    delay = Math.min(delay * 2, IN_FLIGHT_MAX_DELAY_MS);
    recheck = true;
  }
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

/** The agent checks and keys run as: init's or govern()'s agentId, else TRACCIA_AGENT_ID. */
function resolveAgentId(): string | undefined {
  return getAgentId() || process.env.TRACCIA_AGENT_ID;
}

/** Freshness evidence belongs to one tenant, agent and run. */
function readScope(): { key: string; traceId: string } | undefined {
  const traceId = runKey(getCurrentSpan()?.context?.traceId);
  if (!traceId) {
    return undefined;
  }
  const agentId = resolveAgentId() || '';
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
): void {
  const key = runKey(traceId);
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

function retrievalContext(traceId: string | undefined): Record<string, unknown> {
  const key = runKey(traceId);
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
): void {
  if (!attributes) {
    return;
  }
  const name = attributes['traccia.prompt.name'];
  if (!name) {
    return;
  }
  const key = runKey(traceId);
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
  const fromSpan = promptFromAttributes(span?.attributes);
  if (fromSpan.name) {
    return fromSpan;
  }
  const traceId = runKey(span?.context?.traceId);
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
    parts.push(`decision ${String(decision.id)}`);
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
 * No decision from Traccia: apply the fail mode. A rejection of the key after this check was sent
 * wins over any fail mode.
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
  const agentId = resolveAgentId();
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
  checkCredentials.set(decision, { apiKey, endpoint, agentId });
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
    const extras = {
      decisionId: decision.id as string | undefined,
      remainingBudgetUsd: decision.remaining_budget_usd as number | null,
      reasons: (decision.reasons as string[]) || [],
    };
    // An idempotency repeat gets its own error, so a compound tool can tell a finished step from
    // any other block. Only obligations.idempotency_denied says that: `reasons` also holds Observe
    // policies' reasons, so an idempotency reason there may sit beside another policy's Block.
    const obligations = (decision.obligations ?? {}) as Record<string, unknown>;
    const denied = obligations.idempotency_denied;
    if ((IDEMPOTENCY_DENY_REASONS as readonly unknown[]).includes(denied)) {
      throw new IdempotencyRepeatError(blockedMessage(decision), { ...extras, reason: denied as IdempotencyDenyReason });
    }
    throw new AgentBlockedError(blockedMessage(decision), extras);
  }
  return decision;
}


/**
 * The credentials and agent each policy decision was checked with (see checkPolicy), so
 * settlePolicy can settle it there.
 */
const checkCredentials = new WeakMap<object, { apiKey: string; endpoint: string; agentId: string }>();

/**
 * The USD amount the policy check reserved for a call, if any.
 */
export function reservedUsd(decision: Record<string, unknown> | undefined): number | undefined {
  const reserved = (decision?.obligations as Record<string, unknown> | undefined)?.reserved_usd;
  return typeof reserved === 'number' ? reserved : undefined;
}

export const SETTLE_FAILED_ATTRIBUTE = 'traccia.idempotency.settle_failed';
export const DOWNSTREAM_KEY_ATTRIBUTE = 'traccia.idempotency.downstream_key';

/** How a tool call's idempotency reservation is settled. */
export const OUTCOME_COMMIT = 'commit';
export const OUTCOME_RELEASE = 'release';
export const OUTCOME_UNCONFIRMED = 'unconfirmed';
export const OUTCOME_ABANDON = 'abandon';
export const OUTCOMES = [OUTCOME_COMMIT, OUTCOME_RELEASE, OUTCOME_UNCONFIRMED, OUTCOME_ABANDON] as const;
export type IdempotencyOutcome = (typeof OUTCOMES)[number];

function stampSettleFailed(): void {
  getCurrentSpan()?.setAttribute(SETTLE_FAILED_ATTRIBUTE, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** A settle the server answered but did not apply: a 4xx, or a 2xx whose JSON body has `ok: false`. */
function settleLost(status: number | undefined, data: unknown): boolean {
  if (status !== undefined && status >= 400 && status < 500) {
    return true;
  }
  return isRecord(data) && data.ok === false; // a body that is not JSON counts as applied
}

/**
 * How a governed call ended, for settling its reservation. When `actualUsd` is missing, the
 * server prices the call from `model`, `vendor` and the token counts; with none of them it
 * releases the reservation.
 *
 * How to settle: an LLM or budget settle passes `release`; a tool call passes its `outcome`,
 * from which the wire `release` is derived (true for anything but commit).
 */
export type SettleOptions = {
  actualUsd?: number;
  model?: string;
  vendor?: string;
  inputTokens?: number;
  outputTokens?: number;
} & (
  | { release?: boolean; outcome?: undefined }
  | { outcome: IdempotencyOutcome; release?: undefined }
);

/**
 * Settle the call's reservation: the USD reserved for an LLM call and/or the idempotency key
 * reserved for a tool call. `unconfirmed` holds the key (the call may have happened); `abandon`
 * frees the reservation but keeps its downstream key.
 */
export async function settlePolicy(
  decision: Record<string, unknown> | undefined,
  opts: SettleOptions = {},
): Promise<void> {
  const obligations = decision?.obligations as Record<string, unknown> | undefined;
  const reserved = obligations?.reserved_usd;
  const idempotency = isRecord(obligations?.idempotency) ? obligations.idempotency : undefined;
  if (reserved == null && !idempotency) {
    return;
  }
  // The reservation belongs to the account and agent its check used, so settle there. This
  // also keeps a settle that starts after stopTracing() cleared the init() credentials working.
  const bound = decision ? checkCredentials.get(decision) : undefined;
  const { apiKey, endpoint } = bound ?? resolveClientCredentials();
  const agentId = bound?.agentId || resolveAgentId();
  if (!apiKey || !endpoint || !agentId) {
    if (idempotency) {
      stampSettleFailed();
    }
    return;
  }
  const outcome: IdempotencyOutcome = opts.outcome ?? (opts.release ? OUTCOME_RELEASE : OUTCOME_COMMIT);
  const span = getCurrentSpan();
  const body: Record<string, unknown> = {
    agent_id: agentId,
    trace_id: asOtelHex(span?.context?.traceId, 32),
    reserved_usd: reserved,
    actual_usd: opts.actualUsd,
    release: outcome !== OUTCOME_COMMIT,
    model: opts.model,
    vendor: opts.vendor,
    input_tokens: opts.inputTokens,
    output_tokens: opts.outputTokens,
  };
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (!idempotency) {
    try {
      const base = deriveBaseUrl(endpoint);
      await httpClient.post(`${base}${SETTLE_PATH}`, body, { headers });
    } catch {
      // settle is best-effort
    }
    return;
  }
  // An exception or a 5xx is tried once more; a 4xx or {"ok": false} is lost, as a retry would
  // not help. Either way the failure is stamped on the span and swallowed.
  if (reserved == null) {
    delete body.reserved_usd;
  }
  body.idempotency = { ...idempotency, outcome };
  for (let attempt = 0; attempt < 2; attempt++) {
    let status: number | undefined;
    let data: unknown;
    try {
      const base = deriveBaseUrl(endpoint);
      const response = await httpClient.post(`${base}${SETTLE_PATH}`, body, { headers });
      status = response?.status;
      data = response?.data;
    } catch (error) {
      status = axios.isAxiosError(error) ? error.response?.status : undefined;
      data = axios.isAxiosError(error) ? error.response?.data : undefined;
      if (status === undefined) {
        continue; // no answer: try again
      }
    }
    if (status !== undefined && status >= 500) {
      continue;
    }
    if (settleLost(status, data)) {
      console.warn(`[traccia.governance] idempotency settle was not applied (HTTP ${status})`);
      stampSettleFailed();
    }
    return;
  }
  console.warn('[traccia.governance] idempotency settle failed after two attempts');
  stampSettleFailed();
}

/**
 * Characters one image is counted as in a prompt estimate: 1,000 tokens, in the range vision
 * models charge for a typical image.
 */
export const IMAGE_PROMPT_CHARS = 4000;

const IMAGE_PART_TYPES = new Set(['image_url', 'image', 'input_image']);

/**
 * Characters of prompt in one message's content: a string, or an array of content parts
 * (text parts by their text, image parts at IMAGE_PROMPT_CHARS each).
 */
function contentChars(content: unknown): number {
  if (typeof content === 'string') {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let chars = 0;
  for (const part of content) {
    if (typeof part === 'string') {
      chars += part.length;
      continue;
    }
    const p = (part ?? {}) as Record<string, unknown>;
    if (typeof p.text === 'string') {
      chars += p.text.length;
    } else if (typeof p.type === 'string' && IMAGE_PART_TYPES.has(p.type)) {
      chars += IMAGE_PROMPT_CHARS;
    }
  }
  return chars;
}

/**
 * Characters of tool call arguments in an assistant message, which are part of the prompt
 * when the conversation is sent back.
 */
function toolCallChars(message: Record<string, unknown>): number {
  const calls = message.tool_calls;
  if (!Array.isArray(calls)) {
    return 0;
  }
  let chars = 0;
  for (const call of calls) {
    const args = ((call ?? {}) as { function?: { arguments?: unknown } }).function?.arguments;
    chars += typeof args === 'string' ? args.length : 0;
  }
  return chars;
}

/**
 * Rough prompt size in tokens (characters / 4), as sent with the policy check.
 */
export function estimateTokens(kwargs: Record<string, unknown>): number | undefined {
  const messages = kwargs.messages;
  let chars = 0;
  if (Array.isArray(messages)) {
    for (const item of messages) {
      const message = (item ?? {}) as Record<string, unknown>;
      chars += contentChars(message.content) + toolCallChars(message);
    }
    // One separator per message boundary, as when the messages were joined with newlines.
    chars += Math.max(messages.length - 1, 0);
  } else if (typeof kwargs.prompt === 'string') {
    chars = kwargs.prompt.length;
  } else if (typeof kwargs.input === 'string') {
    chars = kwargs.input.length;
  }
  if (!chars) {
    return undefined;
  }
  return Math.max(Math.floor(chars / 4), 1);
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
  const context: Record<string, unknown> = {
    model,
    max_tokens: capParams[capKey],
    input_tokens: estimateTokens(kwargs),
    retrieval: retrievalContext(traceId),
  };
  if (vendor) {
    // Picks that provider's price when the model name alone is ambiguous.
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
  opts: SettleOptions = {},
): Promise<void> {
  await settlePolicy(decision, opts);
}

const pendingSettles = new Set<Promise<unknown>>();

/**
 * Keep track of a settle running in the background, so flushPendingSettles() can wait for
 * it before tracing stops. The promise must not reject.
 */
export function trackPendingSettle(settle: Promise<unknown>): void {
  pendingSettles.add(settle);
  void settle.finally(() => pendingSettles.delete(settle));
}

/**
 * Wait for every background settle started so far. stopTracing() calls this.
 */
export async function flushPendingSettles(): Promise<void> {
  await Promise.all(Array.from(pendingSettles));
}

/** An LLM call still in flight: an open stream, or a request that has not returned. */
export interface OpenCall {
  /**
   * Settle the call at its reported usage, or its reservation when that is unknown, and end
   * its span. With `stop` (the default) a call with a reservation is also stopped where
   * possible, to bound what it is billed; otherwise it goes on and its later end records
   * nothing more. Resolves once the settle has started
   * (after the policy check, if that is still pending).
   */
  settleAtShutdown(stop?: boolean): Promise<void>;
  /** Resolves once the call has ended, however it ended, and its settle has started. */
  finished(): Promise<void>;
}

const openCalls = new Set<OpenCall>();

/** Register a call in flight; settleOpenCalls() settles it if it is still open then. */
export function trackOpenCall(call: OpenCall): void {
  openCalls.add(call);
}

export function untrackOpenCall(call: OpenCall): void {
  openCalls.delete(call);
}

/** Default time limit for settleOpenCalls(), as traccia-py's stop_tracing() uses. */
export const SHUTDOWN_SETTLE_TIMEOUT_MS = 10_000;

/** How long drainOpenCalls() waits past its limit for policy checks still pending. */
const DRAIN_GRACE_MS = 1_000;

/** Run `work` for at most `timeoutMs`. True if it finished in time. */
async function withinTimeLimit(timeoutMs: number, work: () => Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    // Never keep the process alive just for this limit.
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work().then(() => true), timeUp]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settle the calls still in flight, then wait for every pending settle, all within
 * `timeoutMs`. Each call with a reservation is stopped where possible; each is charged what it
 * reported, or its reservation when that is unknown. stopTracing() calls this.
 */
export async function settleOpenCalls(timeoutMs = SHUTDOWN_SETTLE_TIMEOUT_MS): Promise<void> {
  const calls = Array.from(openCalls);
  await withinTimeLimit(timeoutMs, async () => {
    await Promise.all(calls.map((call) => call.settleAtShutdown().catch(() => undefined)));
    await flushPendingSettles();
  });
}

/**
 * Let the calls in flight finish on their own and wait for every pending settle, within
 * `timeoutMs`; nothing is stopped. Calls still open when the time is up are settled then, at
 * their reported usage or else their reservation, and go on: their later end records nothing
 * more, and a stream among them is stopped once the app drops it. One whose policy check is
 * still pending is waited for up to DRAIN_GRACE_MS more. The SIGTERM/SIGINT hook calls this,
 * since the app keeps running (and may be draining its own work) after the signal.
 */
export async function drainOpenCalls(timeoutMs = SHUTDOWN_SETTLE_TIMEOUT_MS): Promise<void> {
  const calls = Array.from(openCalls);
  const drained = await withinTimeLimit(timeoutMs, async () => {
    await Promise.all(calls.map((call) => call.finished().catch(() => undefined)));
    await flushPendingSettles();
  });
  if (!drained) {
    // A call that finished meanwhile is not settled again. One whose policy check is still
    // pending ends once that decides: wait a little for it, so its span ends before the hook
    // shuts the tracer down.
    await withinTimeLimit(Math.min(DRAIN_GRACE_MS, timeoutMs), async () => {
      await Promise.all(calls.map((call) => call.settleAtShutdown(false).catch(() => undefined)));
    });
  }
}

/**
 * What a tool check says about idempotency: the call key (with the key the tool falls back on when
 * a check gets no answer, and whether this re-checks a call that was in flight), or why the call
 * has none.
 */
type ToolCheckIdempotency = { unkeyable: string } | { key: string; fallbackKey?: string; recheck?: boolean };

function idempotencyWire(idempotency: ToolCheckIdempotency): Record<string, unknown> {
  if ('unkeyable' in idempotency) return { unkeyable: idempotency.unkeyable };
  const wire: Record<string, unknown> = { key: idempotency.key };
  if (idempotency.fallbackKey !== undefined) wire.fallback_key = idempotency.fallbackKey;
  if (idempotency.recheck) wire.recheck = true;
  return wire;
}

/** Check a tool call. `idempotency` marks it idempotent; `scope` 'workspace' shares its key across agents. */
export async function enforceToolCall(
  name: string,
  args: Record<string, unknown> = {},
  idempotency?: ToolCheckIdempotency,
  scope?: 'agent' | 'workspace',
): Promise<Record<string, unknown> | undefined> {
  if (!pepEnabled()) {
    return undefined;
  }
  const context: Record<string, unknown> = { input: jsonSafe(args), tool_name: name };
  const freshness = freshnessContext(resourceId(args));
  if (freshness.length) {
    context.freshness = freshness;
  }
  const id = customerId(args);
  if (id) {
    context.customer_id = id;
  }
  const action: Record<string, unknown> = { type: 'tool_call', name };
  if (idempotency !== undefined) {
    action.idempotent = true;
    context.idempotency = idempotencyWire(idempotency);
    if (scope === 'workspace') action.idempotency_scope = 'workspace';
  }
  return checkPolicy({ action, context });
}

/** An idempotent tool's settings, resolved once when the tool is wrapped (see `observe`). */
export interface IdempotencyConfig {
  keyFields?: string[];
  keyTypes?: Record<string, KeyType>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  keyExtra?: (this: any, ...args: any[]) => unknown;
  unconfirmedOn?: (error: unknown) => boolean;
  releaseOn?: (error: unknown) => boolean;
  releaseUnconfirmed: boolean;
  scope: 'agent' | 'workspace';
  inFlightWaitMs: number;
}

/** One call of an idempotent tool. */
export interface IdempotentToolCall {
  config: IdempotencyConfig;
  /** The arguments the key is derived from, key types already applied; an `Unkeyable` when there are none. */
  keyArguments: Record<string, unknown> | Unkeyable;
  /** `config.keyExtra` bound to this call's `this` and arguments. */
  extra?: () => unknown;
}

/** The key for this call, or why it has none. Only the reason, never an error message, goes on the wire. */
function keyFor(name: string, call: IdempotentToolCall): string | Unkeyable {
  const material = call.keyArguments;
  if (material instanceof Unkeyable) {
    return material;
  }
  let extra: unknown;
  if (call.extra) {
    try {
      extra = call.extra();
    } catch (error) {
      return unkeyableFrom(error, 'computing keyExtra');
    }
  }
  try {
    // A workspace-scoped key leaves the agent out, so every agent derives the same one.
    const agent = call.config.scope === 'workspace' ? undefined : resolveAgentId();
    return deriveKey(agent, name, material, call.config.keyFields, extra);
  } catch (error) {
    // e.g. a throwing getter
    return error instanceof Unkeyable ? error : unkeyableFrom(error, 'keying arguments');
  }
}

/**
 * The downstream key, which `idempotencyKey()` returns: the per-attempt key the check handed back
 * (new for each new action, the same for a retry of an attempt that may have happened). Without
 * one (checks off, Traccia unreachable, an older dashboard), `offline`: the call's
 * offlineDownstreamKey, which its check sent as the fallback key. Stamped on the span; the call
 * key never is.
 */
function resolveDownstreamKey(decision: Record<string, unknown> | undefined, offline: string): string {
  const obligations = decision?.obligations as Record<string, unknown> | undefined;
  const fromCheck = obligations?.idempotency_downstream_key;
  const key = typeof fromCheck === 'string' && KEY_PATTERN.test(fromCheck) ? fromCheck : offline;
  getCurrentSpan()?.setAttribute(DOWNSTREAM_KEY_ATTRIBUTE, key);
  return key;
}

/**
 * `idk1_` + HMAC-SHA256(API key, call key), so whoever receives it cannot reverse it by guessing the
 * arguments, as in the Python SDK; the call key itself when no API key is set.
 */
function offlineDownstreamKey(callKey: string): string {
  let apiKey: string | undefined;
  try {
    apiKey = resolveClientCredentials().apiKey;
  } catch {
    apiKey = undefined;
  }
  if (!apiKey) return callKey;
  return KEY_PREFIX + createHmac('sha256', apiKey).update(callKey, 'utf8').digest('hex');
}

/** Settle a tool call; a settle error never replaces the tool's result or error. */
async function settleQuietly(decision: Record<string, unknown> | undefined, outcome: IdempotencyOutcome): Promise<void> {
  if (!decision) {
    return;
  }
  try {
    await settlePolicy(decision, { outcome });
  } catch {
    // swallowed: the tool's own outcome wins
  }
}

/**
 * How a tool call that threw settles. A failure the tool says is definite (`DefiniteFailure` or
 * `releaseOn`; see `isUnconfirmed`) releases the key.
 * Any other error may have happened: it is held as unconfirmed, so a retry inside the window is not
 * run blind, or with releaseUnconfirmed abandoned, so the retry runs with the same downstream key.
 * Classifying never costs the settle: a throwing hook, or a throwing getter on the error, counts
 * as "may have happened".
 */
function failureOutcome(error: unknown, config: IdempotencyConfig | undefined): IdempotencyOutcome {
  let maybeDone: boolean;
  try {
    maybeDone = isUnconfirmed(error, config?.unconfirmedOn, config?.releaseOn);
  } catch {
    maybeDone = true;
  }
  if (!maybeDone) return OUTCOME_RELEASE;
  return config?.releaseUnconfirmed ? OUTCOME_ABANDON : OUTCOME_UNCONFIRMED;
}

/**
 * Check a tool call, run it, then settle what the check reserved.
 *
 * With `idempotency` the key is derived and bound for `idempotencyKey()` even when policy checks
 * are off or could not reach Traccia. The key is committed when `run` resolves. When it throws or
 * rejects, the key is released, or held as unconfirmed if the call may still have happened (see
 * `isUnconfirmed`); the original error is rethrown. The settle is awaited before this resolves or
 * rejects, so an immediate retry is never seen as in flight.
 */
export async function governedToolCall<T>(
  name: string,
  args: Record<string, unknown>,
  idempotency: IdempotentToolCall | undefined,
  run: () => T | PromiseLike<T>,
): Promise<T> {
  let decision: Record<string, unknown> | undefined;
  let callKey: string | undefined;
  let downstreamKey: string | undefined;
  let unkeyable: Unkeyable | undefined;
  if (!idempotency) {
    decision = await enforceToolCall(name, args);
  } else {
    const { config } = idempotency;
    const keyed = keyFor(name, idempotency);
    if (keyed instanceof Unkeyable) {
      unkeyable = keyed;
      decision = await enforceToolCall(name, args, { unkeyable: keyed.message }, config.scope);
    } else {
      const key = keyed;
      callKey = key;
      // The tool called itself with the same arguments: checked without waiting out its own
      // in-flight reservation, so a Block policy denies it at once and anything else lets it run.
      const reentrant = isRunning(key);
      // What the tool passes downstream if a check gets no answer; a fresh attempt adopts it, so a
      // retry after a lost answer passes the same key.
      const offline = offlineDownstreamKey(key);
      const check: { key: string; fallbackKey?: string } = offline === key ? { key } : { key, fallbackKey: offline };
      decision = await checkWaitingInFlight(
        // A check made while waiting out an in-flight call is flagged, so the server neither counts it
        // as another tool call nor stores or alerts on it while it is still in flight.
        (recheck) => enforceToolCall(name, args, recheck ? { ...check, recheck: true } : check, config.scope),
        reentrant ? 0 : config.inFlightWaitMs,
      );
      downstreamKey = resolveDownstreamKey(decision, offline);
    }
  }
  const bindValue = downstreamKey ?? unkeyable;
  let result: T;
  try {
    if (bindValue === undefined) {
      result = await run();
    } else {
      const call: ActiveCall | undefined = callKey === undefined ? undefined : { key: callKey, running: true };
      try {
        result = await bindKey(bindValue, run, call);
      } finally {
        if (call) call.running = false;
      }
    }
  } catch (error) {
    await settleQuietly(decision, failureOutcome(error, idempotency?.config));
    throw error;
  }
  await settleQuietly(decision, OUTCOME_COMMIT);
  return result;
}
