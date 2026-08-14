/**
 * evaluate() runner — Braintrust/Langfuse-style offline experiments.
 */

import { randomUUID } from 'crypto';
import { getTracer, getTracerProvider, init, isTracingStarted } from '../auto';
import { BUILTIN_SCORERS, runBuiltinScorer } from './builtins';
import * as evalClient from './client';
import { EvaluateError } from './errors';

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
}) => unknown | Promise<unknown>;

export type ScorerSpec = string | ScorerFn;
export type DataSpec = string | Array<Record<string, unknown>>;

export type EvaluateOptions = {
  name: string;
  data: DataSpec;
  task: (input: any) => unknown | Promise<unknown>;
  scorers?: ScorerSpec[];
  prompt?: string;
  maxConcurrency?: number;
  persist?: boolean;
  providerKeys?: Record<string, string>;
  apiKey?: string;
  promptApiBase?: string;
  progress?: boolean;
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
  errors: Array<{ item_id: string; error: string }>;

  constructor(init: {
    name: string;
    rows: Record<string, unknown>[];
    aggregates: Record<string, unknown>;
    experimentId?: string | null;
    datasetId?: string | null;
    url?: string | null;
    persistError?: string | null;
    errors?: Array<{ item_id: string; error: string }>;
  }) {
    this.name = init.name;
    this.rows = init.rows;
    this.aggregates = init.aggregates;
    this.experimentId = init.experimentId ?? null;
    this.datasetId = init.datasetId ?? null;
    this.url = init.url ?? null;
    this.persistError = init.persistError ?? null;
    this.errors = init.errors || [];
  }

  summary(): string {
    const agg = this.aggregates || {};
    const lines = [
      `Experiment: ${this.name}`,
      `Items: ${agg.item_count ?? this.rows.length}`,
      `Pass rate: ${agg.pass_rate}`,
      `Scored: ${agg.scored_count ?? 0}`,
      `Errors: ${this.errors.length}`,
    ];
    if (this.url) lines.push(`URL: ${this.url}`);
    else if (this.persistError) lines.push(`Persist error: ${this.persistError}`);
    else if (!this.experimentId) lines.push('Persisted: no (local-only)');
    return lines.join('\n');
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
    out.name = out.name || out.scorer_name || defaultName;
    if (out.passed == null && typeof out.score === 'number') {
      out.passed = out.score >= 0.5;
    }
    if (out.passed == null) out.passed = false;
    return out;
  }
  if (typeof raw === 'number') {
    return { name: defaultName, score: raw, passed: raw >= 0.5 };
  }
  if (typeof raw === 'boolean') {
    return { name: defaultName, score: raw ? 1 : 0, passed: raw };
  }
  return { name: defaultName, passed: false, reason: 'invalid_scorer_return', score: 0 };
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
    while (true) {
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

function annotateScoreSpan(span: any, scored: Record<string, unknown>): void {
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

function costFromSpan(span: any): number | undefined {
  const attrs = span?.attributes || {};
  for (const key of ['llm.cost.usd', 'platform_cost_usd', 'traccia.cost.usd']) {
    const raw = attrs[key];
    if (raw == null) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
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
  let items: Array<{
    id: string;
    input: Record<string, unknown>;
    expected_output?: unknown;
    metadata?: unknown;
  }>;

  if (typeof opts.data === 'string') {
    const ds = await evalClient.fetchDataset(opts.data.trim(), cred);
    datasetId = String(ds.id);
    const rawItems = await evalClient.fetchDatasetItems(datasetId, cred);
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
    promptVersionIds = await evalClient.resolvePromptVersionIds(opts.prompt, cred);
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
        return normalizeScore(raw, nm);
      } catch (err: any) {
        return { name: nm, passed: false, reason: `scorer_error: ${err?.message || err}`, score: 0 };
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
    const stype = String(scorer.type || '');
    if (BUILTIN_SCORERS.has(stype)) {
      const scored = runBuiltinScorer(stype, {
        output,
        expected: row.expected_output,
        config: (scorer.config as Record<string, unknown>) || {},
      });
      return {
        ...scored,
        scorer_id: String(scorer.id || ''),
        scorer_name: String(scorer.name || nm),
        type: stype,
        config: scorer.config || {},
      };
    }
    const remote = await evalClient.scoreRemote({
      scorerId: String(scorer.id),
      output,
      expectedOutput: row.expected_output,
      input: row.input,
      providerKeys: opts.providerKeys,
      ...cred,
    });
    return {
      scorer_id: String(remote.scorer_id || scorer.id || ''),
      scorer_name: String(remote.scorer_name || scorer.name || nm),
      type: remote.type || stype,
      config: remote.config || scorer.config || {},
      name: String(remote.scorer_name || nm),
      passed: Boolean(remote.passed),
      reason: remote.reason,
      score: remote.score,
      model: remote.model,
      latency_ms: remote.latency_ms,
      cost_usd: remote.cost_usd,
      usage: remote.usage && typeof remote.usage === 'object' ? remote.usage : undefined,
    };
  };

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
        const output = jsonable(await opts.task(row.input));
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
              } catch (err: any) {
                const fail: Record<string, unknown> = {
                  name: specNm,
                  scorer_name: specNm,
                  passed: false,
                  reason: `scorer_error: ${err?.message || err}`,
                  score: 0,
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
        let scoreCost = 0;
        let scoreCostKnown = false;
        for (const s of scores) {
          if (s.cost_usd != null && Number.isFinite(Number(s.cost_usd))) {
            scoreCost += Number(s.cost_usd);
            scoreCostKnown = true;
          }
        }
        const spanCost = costFromSpan(span);
        if (spanCost != null || scoreCostKnown) {
          cell.cost_usd = (spanCost || 0) + scoreCost;
        }
        try {
          span.setAttribute('traccia.eval.passed', Boolean(cell.passed));
          if (cell.latency_ms != null) {
            span.setAttribute('traccia.eval.latency_ms', Number(cell.latency_ms));
          }
        } catch {
          /* ignore */
        }
      } catch (err: any) {
        cell.output = '';
        cell.error = String(err?.message || err);
        cell.scores = [];
        cell.passed = false;
        try {
          span.recordException?.(err);
        } catch {
          /* ignore */
        }
      }
      try {
        if (tracingOk) {
          const ctx: any = span.context;
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
    for (const p of (r.panels as any[]) || []) {
      if (typeof p.latency_ms === 'number' && Number.isFinite(p.latency_ms)) latencyVals.push(p.latency_ms);
      if (typeof p.cost_usd === 'number' && Number.isFinite(p.cost_usd)) costVals.push(p.cost_usd);
      for (const s of p.scores || []) {
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

  const result = new EvaluateResult({
    name,
    rows,
    aggregates,
    experimentId,
    datasetId,
    errors,
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
        ...cred,
      });
      result.url = created.url || null;
      result.experimentId = String(created.id || experimentId);
    } catch (err: any) {
      result.persistError = String(err?.message || err);
    }
  }

  return result;
}
