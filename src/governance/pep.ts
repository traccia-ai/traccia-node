/**
 * SDK policy enforcement point: check() on LLM and tool calls under govern().
 */

import axios, { AxiosInstance } from 'axios';
import { loadConfig } from '../config/config';
import { getAgentId, pepEnabled } from '../config/runtime-config';
import { getCurrentSpan } from '../context/context';
import { AgentBlockedError, ApprovalPending } from './policy';

const CHECK_PATH = '/api/v1/policy/check';
const SETTLE_PATH = '/api/v1/policy/settle';
const BUDGET_TTL_MS = 5000;

let httpClient: AxiosInstance = axios.create({ timeout: 2000 });
const remainingBudget = new Map<string, { ts: number; value: number }>();
const lastReads = new Map<string, { tool: string; read_at: string; field: string }>();
const retrievalByTrace = new Map<string, { present?: boolean; chunk_count?: unknown }>();
const promptByTrace = new Map<string, { name: string; label?: unknown; version_id?: unknown }>();

export function _setPepHttpClientForTests(client: AxiosInstance): void {
  httpClient = client;
}

export function _resetPepStateForTests(): void {
  remainingBudget.clear();
  lastReads.clear();
  retrievalByTrace.clear();
  promptByTrace.clear();
  httpClient = axios.create({ timeout: 2000 });
}

export function rememberToolResult(name: string, result: unknown): void {
  if (!name || !result || typeof result !== 'object' || Array.isArray(result)) {
    return;
  }
  const row = result as Record<string, unknown>;
  for (const field of ['as_of', 'updated_at'] as const) {
    const value = row[field];
    if (value != null && value !== '') {
      lastReads.set(name, { tool: name, read_at: String(value), field });
      return;
    }
  }
}

export function noteRetrievalAttributes(
  traceId: string | undefined,
  attributes: Record<string, unknown> | undefined,
): void {
  if (!traceId || !attributes) {
    return;
  }
  const chunk = attributes['traccia.retrieval.chunk_count'];
  const presentFlag = attributes['traccia.retrieval.present'];
  if (chunk == null && presentFlag == null) {
    return;
  }
  const entry = retrievalByTrace.get(traceId) || {};
  if (presentFlag === true || chunk != null) {
    entry.present = true;
  }
  if (chunk != null) {
    entry.chunk_count = chunk;
  }
  retrievalByTrace.set(traceId, entry);
}

function freshnessContext(): Array<Record<string, string>> {
  return Array.from(lastReads.values()).map((item) => ({ ...item }));
}

function retrievalContext(traceId: string | undefined): Record<string, unknown> {
  if (!traceId) {
    return { present: false };
  }
  const found = retrievalByTrace.get(traceId);
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
  const key = asOtelHex(traceId, 32);
  if (!key) {
    return;
  }
  const entry: { name: string; label?: unknown; version_id?: unknown } = { name: String(name) };
  if (attributes['traccia.prompt.label']) entry.label = attributes['traccia.prompt.label'];
  if (attributes['traccia.prompt.version_id']) entry.version_id = attributes['traccia.prompt.version_id'];
  promptByTrace.set(key, entry);
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
  const traceId = asOtelHex(span?.context?.traceId, 32);
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
    if (decision.effect === 'queue') {
      throw new ApprovalPending(
        'This action is waiting for approval. Do not run the tool or retry the check.',
        {
          approvalId: decision.approval_id as string | undefined,
          expiresAt: decision.approval_expires_at as string | undefined,
          decisionId: decision.id as string | undefined,
        },
      );
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
    if (error instanceof AgentBlockedError || error instanceof ApprovalPending) {
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

/**
 * How a governed call ended, for settling its reservation. When `actualUsd` is missing, the
 * server prices the call from `model`, `vendor` and the token counts; with none of them it
 * releases the reservation.
 */
export interface SettleOptions {
  release?: boolean;
  actualUsd?: number;
  model?: string;
  vendor?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * The USD amount the policy check reserved for a call, if any.
 */
export function reservedUsd(decision: Record<string, unknown> | undefined): number | undefined {
  const reserved = (decision?.obligations as Record<string, unknown> | undefined)?.reserved_usd;
  return typeof reserved === 'number' ? reserved : undefined;
}

export async function settlePolicy(
  decision: Record<string, unknown> | undefined,
  opts: SettleOptions = {},
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
        model: opts.model,
        vendor: opts.vendor,
        input_tokens: opts.inputTokens,
        output_tokens: opts.outputTokens,
      },
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
  } catch {
    // settle is best-effort
  }
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

export async function enforceLlmCall(
  kwargs: Record<string, unknown>,
  opts: { vendor?: string } = {},
): Promise<Record<string, unknown> | undefined> {
  if (!pepEnabled()) {
    return undefined;
  }
  const model = kwargs.model;
  const span = getCurrentSpan();
  const traceId = asOtelHex(span?.context?.traceId, 32);
  const context: Record<string, unknown> = {
    model,
    max_tokens: kwargs.max_tokens || kwargs.max_completion_tokens,
    input_tokens: estimateTokens(kwargs),
    retrieval: retrievalContext(traceId),
  };
  if (opts.vendor) {
    // Picks that provider's price when the model name alone is ambiguous.
    context.vendor = opts.vendor;
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
      kwargs.max_tokens = obligations.clamp_max_tokens;
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

export async function enforceToolCall(
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown> | undefined> {
  if (!pepEnabled()) {
    return undefined;
  }
  const context: Record<string, unknown> = { input: args, tool_name: name };
  const freshness = freshnessContext();
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
