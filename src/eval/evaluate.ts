/**
 * evaluate() runner — Braintrust/Langfuse-style offline experiments.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { getTracer, getTracerProvider, init, isTracingStarted, runtimeState } from '../auto';
import { BUILTIN_SCORERS, runBuiltinScorer } from './builtins';
import * as evalClient from './client';
import { EvaluateError } from './errors';
import type { ISpan } from '../types';

/** Message of a thrown value, or the value itself, as text. */
function errorText(err: unknown): string {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return String(message || err);
}

async function ensureEvalTracing(opts: {
  apiKey?: string;
  promptApiBase?: string;
}): Promise<boolean> {
  if (isTracingStarted()) return true;
  try {
    if (!process.env.TRACCIA_AGENT_ID && process.env.AGENT_ID) {
      process.env.TRACCIA_AGENT_ID = process.env.AGENT_ID;
    }
    if (!process.env.TRACCIA_AGENT_ID) {
      process.env.TRACCIA_AGENT_ID = 'sdk-evaluate';
    }
    if (!process.env.TRACCIA_AGENT_NAME && !process.env.AGENT_DASHBOARD_AGENT_NAME) {
      process.env.TRACCIA_AGENT_NAME = 'SDK Evaluate';
    }
    await init({
      apiKey: opts.apiKey,
      promptApiBase: opts.promptApiBase,
    });
    return isTracingStarted();
  } catch {
    return false;
  }
}

export type ScorerFn = (args: {
  input: unknown;
  output: unknown;
  expected?: unknown;
  metadata?: unknown;
}) => unknown; // may return a Promise

export type ScorerSpec = string | ScorerFn;
export type DataSpec = string | Array<Record<string, unknown>>;

export type EvaluateOptions = {
  name: string;
  data: DataSpec;
  task: (input: any) => unknown; // may return a Promise
  scorers?: ScorerSpec[];
  prompt?: string;
  maxConcurrency?: number;
  persist?: boolean;
  providerKeys?: Record<string, string>;
  apiKey?: string;
  promptApiBase?: string;
  progress?: boolean;
  promptVersion?: number | null;
  promptLabel?: string | null;
  runContext?: Record<string, unknown>;
  onItemComplete?: (done: number, total: number, row: Record<string, unknown>) => void;
};

export class EvaluateResult {
  name: string;
  rows: Record<string, unknown>[];
  aggregates: Record<string, unknown>;
  experimentId?: string | null;
  datasetId?: string | null;
  url?: string | null;
  persistError?: string | null;
  runContext: Record<string, unknown>;
  errors: Array<{ item_id: string; error: string }>;

  constructor(init: {
    name: string;
    rows: Record<string, unknown>[];
    aggregates: Record<string, unknown>;
    experimentId?: string | null;
    datasetId?: string | null;
    url?: string | null;
    persistError?: string | null;
    runContext?: Record<string, unknown>;
    errors?: Array<{ item_id: string; error: string }>;
  }) {
    this.name = init.name;
    this.rows = init.rows;
    this.aggregates = init.aggregates;
    this.experimentId = init.experimentId ?? null;
    this.datasetId = init.datasetId ?? null;
    this.url = init.url ?? null;
    this.persistError = init.persistError ?? null;
    this.runContext = init.runContext || {};
    this.errors = init.errors || [];
  }

  summary(): string {
    const agg = this.aggregates || {};
    const lines = [
      `Experiment: ${this.name}`,
      `Items: ${String(agg.item_count ?? this.rows.length)}`,
      `Pass rate: ${String(agg.pass_rate)}`,
      `Scored: ${String(agg.scored_count ?? 0)}`,
      `Errors: ${this.errors.length}`,
    ];
    if (this.url) lines.push(`URL: ${this.url}`);
    else if (this.persistError) lines.push(`Persist error: ${this.persistError}`);
    else if (!this.experimentId) lines.push('Persisted: no (local-only)');
    return lines.join('\n');
  }
}

function snapshotNeedsRefresh(token: unknown, margin = 300): boolean {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  try {
    const payload = JSON.parse(token.slice(0, token.lastIndexOf('.'))) as { exp?: unknown } | null;
    const exp = payload && typeof payload.exp === 'number' ? payload.exp : null;
    return exp != null && exp <= Date.now() / 1000 + margin;
  } catch {
    return false;
  }
}

function normalizeInlineRows(data: Array<Record<string, unknown>>) {
  return data.map((raw, i) => {
    const input = (raw.input ?? raw) as Record<string, unknown>;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new EvaluateError(`Inline data row ${i}: input must be an object`);
    }
    return {
      id: String(raw.id || randomUUID()),
      input,
      expected_output: raw.expected ?? raw.expected_output,
      metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : undefined,
    };
  });
}

function normalizeScore(raw: unknown, defaultName: string): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out = { ...(raw as Record<string, unknown>) };
    out.name = defaultName;
    out.scorer_name = defaultName;
    if (out.score == null && typeof out.passed === 'boolean') {
      out.score = out.passed ? 1 : 0;
    }
    if (out.passed == null && typeof out.score === 'number') {
      out.passed = out.score >= 0.5;
    }
    if (out.passed == null) {
      return { name: defaultName, status: 'error', passed: null, score: null, reason: 'invalid_scorer_return' };
    }
    out.status = out.status || 'judged';
    return out;
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return { name: defaultName, status: 'error', passed: null, score: null, reason: 'non_finite_score' };
    }
    return { name: defaultName, status: 'judged', score: raw, passed: raw >= 0.5 };
  }
  if (typeof raw === 'boolean') {
    return { name: defaultName, status: 'judged', score: raw ? 1 : 0, passed: raw };
  }
  return { name: defaultName, status: 'error', passed: null, reason: 'invalid_scorer_return', score: null };
}

function jsonable(value: unknown): unknown {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

function panelLabel(prompt?: string): string {
  const p = (prompt || '').trim();
  return p || 'Task';
}

function specName(spec: ScorerSpec): string {
  if (typeof spec === 'string') return spec.trim() || 'scorer';
  return spec.name || 'scorer';
}

function scoreSpanName(spec: ScorerSpec): string {
  const raw = specName(spec);
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return `scorer.${safe || 'unnamed'}`;
}

function annotateScoreSpan(span: ISpan, scored: Record<string, unknown>): void {
  try {
    const name = String(scored.scorer_name || scored.name || '');
    if (name) span.setAttribute('traccia.eval.scorer', name);
    if (scored.passed != null) span.setAttribute('traccia.eval.passed', Boolean(scored.passed));
    if (scored.reason) span.setAttribute('traccia.eval.reason', String(scored.reason).slice(0, 500));
    const stype = String(scored.type || '');
    if (stype === 'llm_judge' || scored.model) {
      span.setAttribute('span.type', 'llm');
      if (scored.model) {
        span.setAttribute('llm.model', String(scored.model));
        span.setAttribute('gen_ai.request.model', String(scored.model));
      }
      if (scored.cost_usd != null && Number.isFinite(Number(scored.cost_usd))) {
        span.setAttribute('llm.cost.usd', Number(scored.cost_usd));
      }
      const usage =
        scored.usage && typeof scored.usage === 'object' && !Array.isArray(scored.usage)
          ? (scored.usage as Record<string, unknown>)
          : {};
      const promptT = usage.prompt_tokens ?? usage.input_tokens;
      const completionT = usage.completion_tokens ?? usage.output_tokens;
      if (promptT != null) {
        span.setAttribute('llm.usage.prompt_tokens', Number(promptT));
        span.setAttribute('gen_ai.usage.input_tokens', Number(promptT));
      }
      if (completionT != null) {
        span.setAttribute('llm.usage.completion_tokens', Number(completionT));
        span.setAttribute('gen_ai.usage.output_tokens', Number(completionT));
      }
      if (promptT != null || completionT != null) {
        const total = Number(promptT || 0) + Number(completionT || 0);
        span.setAttribute('llm.usage.total_tokens', total);
        span.setAttribute('gen_ai.usage.total_tokens', total);
      }
    } else {
      span.setAttribute('span.type', 'eval');
    }
  } catch {
    /* ignore */
  }
}

function readCost(attrs: Record<string, unknown> | undefined): number | undefined {
  for (const key of ['llm.cost.usd', 'platform_cost_usd', 'traccia.cost.usd']) {
    const raw = attrs?.[key];
    if (raw == null) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function providerSpan(span: { name?: string; attributes?: Record<string, unknown> }): boolean {
  const attrs = span?.attributes || {};
  if (attrs['llm.model'] || attrs['gen_ai.request.model']) return true;
  const name = String(span?.name || '');
  return name !== 'evaluate.item' && !name.startsWith('scorer.') && name.includes('llm');
}

function taskChildCosts(): AsyncLocalStorage<Array<{ cost: number | null }>> {
  const state = runtimeState();
  if (!state.taskChildCosts) {
    state.taskChildCosts = new AsyncLocalStorage();
  }
  return state.taskChildCosts;
}

function ensureChildCostProcessor(): void {
  const state = runtimeState();
  let provider: ReturnType<typeof getTracerProvider>;
  try {
    provider = getTracerProvider();
  } catch {
    return;
  }
  if (state.costProvider === provider) return;
  state.costProvider = provider;
  try {
    provider.addSpanProcessor({
      onEnd(span) {
        const bucket = taskChildCosts().getStore();
        if (!bucket) return;
        const name = String(span?.name || '');
        if (name === 'evaluate.item' || name.startsWith('scorer.')) return;
        if (!providerSpan(span)) return;
        const cost = readCost(span?.attributes);
        bucket.push({ cost: cost == null ? null : cost });
      },
      forceFlush() {
        return undefined;
      },
      shutdown() {
        return undefined;
      },
    });
  } catch {
    state.costProvider = null;
  }
}

type CostSpan = { name?: string; attributes?: Record<string, unknown>; children?: CostSpan[] };

function costFromSpan(span: CostSpan, childCosts?: Array<{ cost: number | null }>): number | undefined {
  const own = readCost(span?.attributes);
  if (own != null) return own;
  const nested = [...(childCosts || [])];
  for (const child of span?.children || []) {
    if (providerSpan(child)) {
      const cost = costFromSpan(child);
      nested.push({ cost: cost == null ? null : cost });
    }
  }
  if (!nested.length) return undefined;
  if (nested.some((item) => item.cost == null)) return undefined;
  return nested.reduce((sum, item) => sum + Number(item.cost), 0);
}

export function namedScorer(fn: (input: any) => unknown, key: string) {
  const wrapped = (input: any) => fn(input);
  Object.defineProperty(wrapped, 'name', { value: key, configurable: true });
  return wrapped;
}

export async function evaluate(opts: EvaluateOptions): Promise<EvaluateResult> {
  const name = (opts.name || '').trim();
  if (!name) throw new EvaluateError('name is required');
  if (typeof opts.task !== 'function') throw new EvaluateError('task must be a function');
  const maxConcurrency = opts.maxConcurrency ?? 10;
  if (maxConcurrency < 1) throw new EvaluateError('maxConcurrency must be >= 1');
  const persist = opts.persist !== false;
  const progress = opts.progress !== false;
  const scorers = opts.scorers || [];
  const cred = { apiKey: opts.apiKey, promptApiBase: opts.promptApiBase };
  const tracingOk = await ensureEvalTracing(cred);

  let datasetId: string | undefined;
  let datasetSnapshotToken: string | undefined;
  let datasetFingerprint: string | undefined;
  let promptAttachment: string | undefined;
  if (opts.prompt && opts.promptVersion == null && !opts.promptLabel) {
    promptAttachment = 'deprecated_production_default';
    process.stderr.write(
      'warning: prompt without promptVersion or promptLabel still attaches production. The next SDK release removes that default.\n',
    );
  }
  let items: Array<{
    id: string;
    input: Record<string, unknown>;
    expected_output?: unknown;
    metadata?: unknown;
  }>;

  if (typeof opts.data === 'string') {
    const ds = await evalClient.fetchDataset(opts.data.trim(), cred);
    datasetId = String(ds.id);
    const rawPayload = await evalClient.fetchDatasetItemsPayload(datasetId, cred);
    datasetSnapshotToken = rawPayload.dataset_snapshot_token ? String(rawPayload.dataset_snapshot_token) : undefined;
    datasetFingerprint = rawPayload.dataset_fingerprint ? String(rawPayload.dataset_fingerprint) : undefined;
    const rawItems = (rawPayload.items || []) as Record<string, unknown>[];
    items = rawItems.map((it) => ({
      id: String(it.id),
      input: (it.input as Record<string, unknown>) || {},
      expected_output: it.expected_output,
      metadata: it.metadata,
    }));
  } else if (Array.isArray(opts.data)) {
    items = normalizeInlineRows(opts.data);
    if (persist) {
      const short = randomUUID().slice(0, 8);
      const safeName = name.replace(/\//g, '-').slice(0, 80);
      const ephemeral = await evalClient.createEphemeralDataset({
        name: `sdk-eval/${safeName}/${short}`,
        description: 'Created by SDK evaluate() (ephemeral)',
        items: items.map((it) => ({
          input: it.input,
          expected_output: it.expected_output,
          metadata: it.metadata,
        })),
        ...cred,
      });
      datasetId = String(ephemeral.id);
      const created = (ephemeral.items || []) as Array<Record<string, unknown>>;
      if (created.length === items.length) {
        items = items.map((it, i) => ({ ...it, id: String(created[i].id) }));
      }
    }
  } else {
    throw new EvaluateError('data must be a dataset name/id string or a list of rows');
  }

  if (!items.length) throw new EvaluateError('No items to evaluate (empty dataset or list)');

  const experimentId = persist ? randomUUID() : undefined;
  let promptVersionIds: string[] = [];
  if (persist && opts.prompt) {
    promptVersionIds = await evalClient.resolvePromptVersionIds(opts.prompt, {
      ...cred,
      version: opts.promptVersion,
      label: opts.promptLabel,
    });
  }

  const scorerCache = new Map<string, Record<string, unknown>>();
  const platformScorerIds: string[] = [];
  for (const spec of scorers) {
    if (typeof spec === 'string' && !BUILTIN_SCORERS.has(spec.trim())) {
      try {
        const s = await evalClient.fetchScorer(spec.trim(), cred);
        scorerCache.set(spec.trim(), s);
        platformScorerIds.push(String(s.id));
      } catch {
        /* resolve per-item */
      }
    }
  }

  const resultsByIndex: Record<number, Record<string, unknown>> = {};
  const errors: Array<{ item_id: string; error: string }> = [];
  let completed = 0;
  const total = items.length;

  const runScorer = async (
    spec: ScorerSpec,
    row: (typeof items)[0],
    output: unknown,
  ): Promise<Record<string, unknown>> => {
    if (typeof spec === 'function') {
      const nm = spec.name || 'scorer';
      try {
        const raw = await spec({
          input: row.input,
          output,
          expected: row.expected_output,
          metadata: row.metadata,
        });
        const scored = normalizeScore(raw, nm);
        if (!scored.definition_hash && !scored.definition_identity) {
          scored.definition_identity = 'source_fallback';
        }
        return scored;
      } catch (err: unknown) {
        return {
          name: nm,
          status: 'error',
          passed: null,
          score: null,
          reason: `scorer_error: ${errorText(err)}`,
          definition_identity: 'source_fallback',
        };
      }
    }
    const nm = String(spec).trim();
    if (BUILTIN_SCORERS.has(nm)) {
      return runBuiltinScorer(nm, { output, expected: row.expected_output });
    }
    let scorer = scorerCache.get(nm);
    if (!scorer) {
      scorer = await evalClient.fetchScorer(nm, cred);
      scorerCache.set(nm, scorer);
    }
    if (snapshotNeedsRefresh(scorer.scorer_snapshot_token)) {
      scorer = await evalClient.fetchScorer(nm, cred);
      scorerCache.set(nm, scorer);
    }
    const stype = String(scorer.type || '');
    if (BUILTIN_SCORERS.has(stype)) {
      const scored = runBuiltinScorer(stype, {
        output,
        expected: row.expected_output,
        config: (scorer.config as Record<string, unknown>) || {},
      });
      const platformName = String(scorer.name || nm);
      const stamped: Record<string, unknown> = {
        ...scored,
        scorer_id: String(scorer.id || ''),
        scorer_name: platformName,
        name: platformName,
        type: stype,
        config: scorer.config || {},
        definition_hash: scorer.definition_hash || scored.definition_hash,
        implementation_version: scorer.implementation_version || scored.implementation_version,
      };
      if (scorer.scorer_snapshot_token) {
        stamped.scorer_snapshot_token = String(scorer.scorer_snapshot_token);
        delete stamped.definition_identity;
      }
      return stamped;
    }
    const remote = await evalClient.scoreRemote({
      scorerId: String(scorer.id),
      output,
      expectedOutput: row.expected_output,
      input: row.input,
      providerKeys: opts.providerKeys,
      scorerSnapshotToken: scorer.scorer_snapshot_token ? String(scorer.scorer_snapshot_token) : undefined,
      ...cred,
    });
    const status = remote.status === 'error' ? 'error' : remote.status || (remote.score != null && typeof remote.passed === 'boolean' ? 'judged' : 'error');
    return {
      scorer_id: String(remote.scorer_id || scorer.id || ''),
      scorer_name: String(remote.scorer_name || scorer.name || nm),
      type: remote.type || stype,
      config: remote.config || scorer.config || {},
      name: String(remote.scorer_name || nm),
      status,
      passed: status === 'error' ? null : remote.passed,
      reason: remote.reason,
      score: status === 'error' ? null : remote.score,
      model: remote.model,
      latency_ms: remote.latency_ms,
      usage: remote.usage && typeof remote.usage === 'object' ? remote.usage : undefined,
      definition_hash: remote.definition_hash || scorer.definition_hash,
      implementation_version: remote.implementation_version || scorer.implementation_version,
      scorer_snapshot_token: remote.scorer_snapshot_token || scorer.scorer_snapshot_token,
      ...(remote.invocation && typeof remote.invocation === 'object' ? { invocation: remote.invocation } : {}),
      ...(Array.isArray(remote.questions) ? { questions: remote.questions } : {}),
      ...("unsure" in remote ? { unsure: remote.unsure } : {}),
    };
  };

  ensureChildCostProcessor();
  await runPool(items, maxConcurrency, async (row, idx) => {
    const cell: Record<string, unknown> = {
      panel_index: 0,
      label: panelLabel(opts.prompt),
      source: 'evaluate',
      prompt_version_id: promptVersionIds[0] || null,
    };
    const attrs: Record<string, unknown> = {
      'traccia.eval.source': 'evaluate',
      'span.type': 'eval',
      'traccia.dataset.item_id': row.id,
    };
    if (experimentId) {
      attrs['traccia.experiment.id'] = experimentId;
      attrs['traccia.experiment.name'] = name;
    }
    if (datasetId) attrs['traccia.dataset.id'] = datasetId;

    const tracer = getTracer('traccia.eval');
    await tracer.startActiveSpan(
      'evaluate.item',
      async (span) => {
      try {
        const t0 = Date.now();
        const childCosts: Array<{ cost: number | null }> = [];
        const output = jsonable(await taskChildCosts().run(childCosts, () => opts.task(row.input)));
        cell.latency_ms = Date.now() - t0;
        cell.output = output;
        cell.error = null;
        const scores: Record<string, unknown>[] = [];
        for (const spec of scorers) {
          const specNm = specName(spec);
          await tracer.startActiveSpan(
            scoreSpanName(spec),
            async (scoreSpan) => {
              try {
                const scored = await runScorer(spec, row, output);
                annotateScoreSpan(scoreSpan, scored);
                scores.push(scored);
              } catch (err: unknown) {
                const fail: Record<string, unknown> = {
                  name: specNm,
                  scorer_name: specNm,
                  status: 'error',
                  passed: null,
                  reason: `scorer_error: ${errorText(err)}`,
                  score: null,
                };
                if (BUILTIN_SCORERS.has(specNm)) fail.type = specNm;
                annotateScoreSpan(scoreSpan, fail);
                scores.push(fail);
              }
            },
            {
              attributes: {
                'span.type': 'eval',
                'traccia.eval.source': 'evaluate',
                'traccia.eval.scorer': specNm,
              },
            },
          );
        }
        cell.scores = scores;
        cell.passed = scorers.length ? scores.every((s) => Boolean(s.passed)) : null;
        const spanCost = costFromSpan(span, childCosts);
        cell.task_cost = spanCost == null
          ? { usd: null, coverage: 'unknown', basis: 'instrumented_spans' }
          : { usd: spanCost, coverage: 'complete', basis: 'instrumented_spans' };
        if (spanCost != null) cell.cost_usd = spanCost;
        try {
          span.setAttribute('traccia.eval.passed', Boolean(cell.passed));
          if (cell.latency_ms != null) {
            span.setAttribute('traccia.eval.latency_ms', Number(cell.latency_ms));
          }
        } catch {
          /* ignore */
        }
      } catch (err: unknown) {
        cell.output = '';
        cell.error = errorText(err);
        cell.scores = [];
        cell.passed = false;
        try {
          span.recordException?.(err as Error);
        } catch {
          /* ignore */
        }
      }
      try {
        if (tracingOk) {
          const ctx = span.context as { traceId?: unknown; trace_id?: unknown } | undefined;
          const tid = ctx?.traceId || ctx?.trace_id;
          if (tid) cell.trace_id = String(tid);
        }
      } catch {
        /* ignore */
      }
    },
      { attributes: attrs },
    );

    const rowOut: Record<string, unknown> = {
      item_id: row.id,
      input: row.input,
      expected_output: row.expected_output,
      panels: [cell],
    };
    resultsByIndex[idx] = rowOut;
    if (cell.error) errors.push({ item_id: row.id, error: String(cell.error) });
    completed += 1;
    if (progress) process.stderr.write(`\r${completed}/${total}`);
    opts.onItemComplete?.(completed, total, rowOut);
  });

  if (progress) process.stderr.write('\n');

  try {
    await getTracerProvider().forceFlush();
  } catch {
    /* ignore */
  }

  const rows = Array.from({ length: total }, (_, i) => resultsByIndex[i]);
  let passCount = 0;
  let scoredCount = 0;
  const latencyVals: number[] = [];
  const costVals: number[] = [];
  for (const r of rows) {
    for (const p of (r.panels as Array<Record<string, unknown>>) || []) {
      if (typeof p.latency_ms === 'number' && Number.isFinite(p.latency_ms)) latencyVals.push(p.latency_ms);
      if (typeof p.cost_usd === 'number' && Number.isFinite(p.cost_usd)) costVals.push(p.cost_usd);
      for (const s of (p.scores as Array<{ passed?: unknown }>) || []) {
        scoredCount += 1;
        if (s.passed) passCount += 1;
      }
    }
  }

  const aggregates: Record<string, unknown> = {
    item_count: rows.length,
    panel_count: 1,
    scorer_count: scorers.length,
    pass_count: passCount,
    scored_count: scoredCount,
    pass_rate: scoredCount ? passCount / scoredCount : null,
    error_count: errors.length,
    source: 'evaluate',
  };
  if (latencyVals.length) {
    aggregates.mean_latency_ms = latencyVals.reduce((a, b) => a + b, 0) / latencyVals.length;
  }
  if (costVals.length) {
    aggregates.total_cost_usd = costVals.reduce((a, b) => a + b, 0);
  }

  const runContext: Record<string, unknown> = {
    ...(opts.runContext || {}),
    ...(datasetFingerprint ? { dataset_fingerprint: datasetFingerprint } : {}),
    ...(promptAttachment ? { prompt_attachment: promptAttachment } : {}),
    latency_concurrency: maxConcurrency,
    latency_semantics: 'task_wall_per_item',
  };
  const result = new EvaluateResult({
    name,
    rows,
    aggregates,
    experimentId,
    datasetId,
    errors,
    runContext,
  });

  if (persist) {
    if (!datasetId) {
      result.persistError = 'Missing dataset_id for persist';
      return result;
    }
    try {
      const created = await evalClient.createExperiment({
        datasetId,
        name,
        experimentId,
        promptVersionIds,
        scorerIds: platformScorerIds,
        results: { rows },
        aggregates,
        runContext,
        datasetSnapshotToken,
        ...cred,
      });
      result.url = (created.url as string) || null;
      result.experimentId = String(created.id || experimentId);
      result.runContext = (created.run_context as Record<string, unknown>) || runContext;
    } catch (err: unknown) {
      result.persistError = errorText(err);
    }
  }

  return result;
}
