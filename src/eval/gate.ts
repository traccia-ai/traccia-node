/** CI eval gate. Exit codes match the Python SDK and the shared fixture. */

import * as fs from 'fs';
import * as path from 'path';

export const SCHEMA_VERSION = 1;

// Shapes of the JSON this gate reads. They come from evaluate() rows, the eval runtime API
// and the shared fixture, so every field is optional and checked before use.

/** One score (or one question of a multi-question score) on a result row panel. */
export type GateScore = {
  name?: unknown;
  scorer_name?: unknown;
  scorer_id?: unknown;
  role?: unknown;
  type?: unknown;
  key?: unknown;
  status?: unknown;
  score?: unknown;
  passed?: unknown;
  questions?: unknown;
  config?: { questions?: unknown } | null;
  definition_hash?: string;
  definition_identity?: string;
  invocation?: { id?: unknown; cost_usd?: unknown } | null;
};

export type GatePanel = {
  scores?: GateScore[];
  task_cost?: { coverage?: unknown; usd?: number } | null;
  cost_usd?: number;
  latency_ms?: number;
};

export type GateRow = { item_id?: unknown; panels?: GatePanel[] };

export type GateFailure = { code: string; message: string };

/** Per-scorer summary row, for the candidate run and for a baseline panel. */
export type ScorerSummary = {
  name?: string;
  scorer_id?: string;
  expected?: number;
  completed?: number;
  missing?: number | boolean;
  errored?: number | boolean;
  duplicate?: boolean;
  passes?: number;
  pass_rate?: number | null;
  informational?: boolean;
  non_finite?: boolean;
  verified?: boolean;
  definition_hash?: string | null;
  definition_conflict?: boolean;
  definition_identity?: string;
  baseline_pass_rate?: number | null;
  baseline_definition_hash?: string;
};

export type ScorerEvidence = { scorer_id?: unknown; name?: unknown; panel_index?: unknown; verified?: boolean };

export type GateThresholds = {
  min_pass_rate?: number | null;
  max_drop?: number | null;
  max_latency_increase?: number | null;
  max_task_cost_increase?: number | null;
  max_judge_cost_increase?: number | null;
};

export type GateOptions = GateThresholds & {
  scorers?: string[];
  informational?: string[];
  baseline_prompt?: string | null;
  baseline_experiment?: string | null;
  baseline_dataset_verified?: boolean;
  baseline_scorer_unverified?: boolean;
  baseline_missing?: boolean;
  baseline_panel_required?: boolean;
  unhashed_scorers?: string[];
  scorer_ids?: Record<string, string>;
};

export type GateReport = GateThresholds & {
  rows?: GateRow[];
  scorers?: ScorerSummary[];
  summary_failed?: boolean;
  persist_error?: unknown;
  dataset_drift?: boolean;
  dataset_verified?: unknown;
  dataset_fingerprint?: unknown;
  dataset_changed?: boolean;
  allow_dataset_change?: boolean;
  task_errors?: number;
  experiment_id?: unknown;
  url?: unknown;
  baseline_experiment_id?: unknown;
  cost_gate?: boolean;
  cost_coverage?: unknown;
  task_cost_increase?: number | null;
  judge_cost_increase?: number | null;
  judge_workload_mismatch?: boolean;
  latency_gate?: boolean;
  latency_incomplete?: boolean;
  latency_increase?: number | null;
  latency_concurrency?: unknown;
  latency_concurrency_mismatch?: boolean;
  allow_concurrency_mismatch?: boolean;
  implementation_mismatch?: boolean;
  scorer_definition_changed?: boolean;
};

/** A baseline experiment panel, as loaded by the CLI. */
export type GateBaseline = {
  missing?: boolean;
  panel_required?: boolean;
  experiment_id?: string;
  panel_index?: number | null;
  prompt_version_id?: unknown;
  dataset_fingerprint?: unknown;
  dataset_verified?: boolean;
  scorer_evidence?: ScorerEvidence[];
  scorers?: ScorerSummary[];
  latency_concurrency?: unknown;
  mean_latency_ms?: number;
  task_cost_usd?: number;
  task_cost_coverage?: unknown;
  judge_cost_usd?: number;
  judge_cost_coverage?: unknown;
  judge_definition_hashes?: string[];
};

export type GateOutcome = {
  exit_code: number;
  code: string | null;
  failures: GateFailure[];
  quality_gate: boolean;
  label: string;
  schema_version: number;
  dataset_fingerprint: unknown;
  dataset_verified: unknown;
  experiment_id: unknown;
  url: unknown;
  scorers: ScorerSummary[];
  gates?: Record<string, unknown>;
};

const RELATIVE_GATES = ['max_latency_increase', 'max_task_cost_increase', 'max_judge_cost_increase'] as const;

function finite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

export function writeSummary(filePath: string, body: Record<string, unknown>): boolean {
  const payload = { schema_version: SCHEMA_VERSION, ...body };
  let tmp = '';
  try {
    const directory = path.dirname(path.resolve(filePath));
    fs.mkdirSync(directory, { recursive: true });
    tmp = path.join(directory, `.traccia-eval-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    return false;
  }
}

function fail(code: number, name: string, message: string) {
  return {
    exit_code: code,
    code: name,
    failures: [{ code: name, message }],
    quality_gate: false,
  };
}

export function preflight(options: GateOptions) {
  const scorers: string[] = options.scorers || [];
  const informational: string[] = options.informational || [];
  const minRate = options.min_pass_rate;
  const maxDrop = options.max_drop;
  if (minRate != null && (!finite(minRate) || minRate < 0 || minRate > 1)) {
    return fail(2, 'bad_flags', 'min pass rate must be between 0 and 1');
  }
  if (maxDrop != null && (!finite(maxDrop) || maxDrop < 0 || maxDrop > 1)) {
    return fail(2, 'bad_flags', 'max drop must be between 0 and 1');
  }
  for (const key of RELATIVE_GATES) {
    const value = options[key];
    if (value != null && (!finite(value) || value < 0)) {
      return fail(2, 'bad_flags', `${key} must be a finite number >= 0`);
    }
  }
  if (options.baseline_prompt && options.baseline_experiment) {
    return fail(2, 'baseline_conflict', 'Pass one baseline, not both');
  }
  const needsRate = minRate != null || maxDrop != null;
  const selected = new Set(scorers.map((item) => String(item).replace(/^local:/, '')));
  const counted = [...selected].filter((name) => !informational.includes(name));
  if (needsRate && counted.length === 0) {
    return fail(2, 'no_scorer', 'A pass rate bar needs a scorer that counts toward the pass rate');
  }
  for (const name of informational) {
    if (!selected.has(name)) return fail(2, 'unknown_scorer', `${name} is not a selected scorer`);
  }
  const relative =
    maxDrop != null ||
    RELATIVE_GATES.some((key) => options[key] != null);
  if (relative && !options.baseline_prompt && !options.baseline_experiment) {
    return fail(2, 'baseline_required', 'This gate needs a baseline');
  }
  if (options.baseline_dataset_verified === false) {
    return fail(2, 'dataset_unverified', 'The baseline dataset is not verified');
  }
  if (options.baseline_scorer_unverified) {
    return fail(2, 'scorer_unverified', 'The baseline scorer is not verified');
  }
  if (options.baseline_missing) return fail(2, 'baseline_missing', 'Baseline was not found');
  if (options.baseline_panel_required) return fail(2, 'bad_flags', 'Choose a baseline panel');
  return null;
}

export function decide(report: GateReport): GateOutcome {
  const failures: GateFailure[] = [];
  if (report.summary_failed) return result(5, 'summary_failed', failures, report, false);
  if (report.persist_error) {
    failures.push({ code: 'persist_failed', message: String(report.persist_error) });
    return result(4, 'persist_failed', failures, report, false);
  }
  if (report.dataset_drift) failures.push({ code: 'dataset_drift', message: 'Dataset changed while the run was in progress' });
  if (!report.rows || report.rows.length === 0) failures.push({ code: 'empty_results', message: 'The run has no items' });
  if (report.task_errors) failures.push({ code: 'task_error', message: 'A task failed' });

  let quality = false;
  for (const scorer of report.scorers || []) {
    const name = scorer.name;
    if (
      report.max_drop != null &&
      !scorer.informational &&
      (scorer.definition_identity === 'source_fallback' || !scorer.definition_hash || !scorer.baseline_definition_hash)
    ) {
      failures.push({ code: 'scorer_definition_unhashed', message: `${name} has no definition hash` });
    }
    if (scorer.errored || scorer.missing) {
      failures.push({
        code: scorer.errored ? 'scorer_error' : 'scorer_coverage',
        message: `${name} coverage is incomplete`,
      });
    }
    if (scorer.non_finite) failures.push({ code: 'non_finite_score', message: `${name} returned a non-finite score` });
    if (scorer.duplicate) failures.push({ code: 'duplicate_score', message: `${name} scored an item more than once` });
  }
  if (report.cost_gate && (report.cost_coverage === 'partial' || report.cost_coverage === 'unknown' || report.cost_coverage == null)) {
    failures.push({ code: 'cost_incomplete', message: 'Task cost is not complete' });
  }
  if (report.latency_gate && report.latency_incomplete) {
    failures.push({ code: 'latency_incomplete', message: 'Every item needs a finite task latency' });
  }
  if (report.latency_concurrency_mismatch && !report.allow_concurrency_mismatch) {
    failures.push({ code: 'latency_concurrency_mismatch', message: 'Latency concurrency does not match the baseline' });
  }
  if (report.judge_workload_mismatch) {
    failures.push({ code: 'judge_workload_mismatch', message: 'Judge scorers do not match the baseline' });
  }
  if (report.implementation_mismatch) {
    failures.push({ code: 'scorer_implementation_mismatch', message: 'Scorer implementation changed during the run' });
  }
  if (report.scorer_definition_changed) {
    failures.push({ code: 'scorer_definition_changed', message: 'Scorer definition does not match the baseline' });
  }
  if ((report.min_pass_rate != null || report.max_drop != null) && report.dataset_verified !== true) {
    failures.push({ code: 'dataset_unverified', message: 'The dataset snapshot was not verified' });
  }
  const comparedNow = (report.scorers || []).filter((scorer) => !scorer.informational);
  if (report.max_drop != null) {
    if (!comparedNow.length) {
      failures.push({ code: 'baseline_missing', message: 'No scorer has a baseline pass rate' });
    }
    for (const scorer of comparedNow) {
      if (scorer.verified === false) {
        failures.push({ code: 'scorer_unverified', message: `${scorer.name} is not verified` });
      }
      if (scorer.baseline_pass_rate == null || !finite(scorer.baseline_pass_rate)) {
        failures.push({ code: 'baseline_missing', message: `${scorer.name} has no baseline pass rate` });
      }
    }
  }
  if (report.max_task_cost_increase != null && report.task_cost_increase == null) {
    failures.push({ code: 'cost_incomplete', message: 'Task cost is not complete' });
  }
  if (report.max_judge_cost_increase != null && !report.judge_workload_mismatch && report.judge_cost_increase == null) {
    failures.push({ code: 'cost_incomplete', message: 'Judge cost is not complete' });
  }
  if (report.max_latency_increase != null && report.latency_increase == null) {
    failures.push({ code: 'latency_incomplete', message: 'Every item needs a finite task latency' });
  }
  if (failures.length) return result(3, failures[0].code, failures, report, false);

  if (report.dataset_changed && !report.allow_dataset_change) {
    failures.push({ code: 'dataset_changed', message: 'Dataset fingerprint does not match the baseline' });
    return result(1, 'dataset_changed', failures, report, true);
  }

  const compared = (report.scorers || []).filter((scorer) => !scorer.informational);
  if ((report.min_pass_rate != null || report.max_drop != null) && compared.length) {
    quality = true;
    for (const scorer of compared) {
      const rate = scorer.pass_rate;
      if (report.min_pass_rate != null && (rate == null || rate < report.min_pass_rate)) {
        failures.push({ code: 'threshold_missed', message: `${scorer.name} is below the pass rate` });
      }
      if (report.max_drop != null && scorer.baseline_pass_rate != null && rate != null) {
        if (scorer.baseline_pass_rate - rate > report.max_drop + 1e-12) {
          failures.push({ code: 'regression', message: `${scorer.name} dropped more than allowed` });
        }
      }
    }
  }
  if (report.task_cost_increase != null && report.max_task_cost_increase != null && report.task_cost_increase > report.max_task_cost_increase + 1e-12) {
    failures.push({ code: 'cost_increase', message: 'Task cost increased more than allowed' });
  }
  if (report.judge_cost_increase != null && report.max_judge_cost_increase != null && report.judge_cost_increase > report.max_judge_cost_increase + 1e-12) {
    failures.push({ code: 'cost_increase', message: 'Judge cost increased more than allowed' });
  }
  if (report.latency_increase != null && report.max_latency_increase != null && report.latency_increase > report.max_latency_increase + 1e-12) {
    failures.push({ code: 'latency_increase', message: 'Latency increased more than allowed' });
  }
  if (failures.length) return result(1, failures[0].code, failures, report, quality);
  return result(0, null, [], report, quality);
}

function result(
  exitCode: number,
  code: string | null,
  failures: GateFailure[],
  report: GateReport,
  qualityGate: boolean,
): GateOutcome {
  const passed = exitCode === 0;
  const body: GateOutcome = {
    exit_code: exitCode,
    code,
    failures,
    quality_gate: passed ? qualityGate : false,
    label: passed ? (qualityGate ? 'Quality Gate' : 'Execution Only') : 'Failed',
    schema_version: SCHEMA_VERSION,
    dataset_fingerprint: report.dataset_fingerprint,
    dataset_verified: report.dataset_verified,
    experiment_id: report.experiment_id,
    url: report.url,
    scorers: report.scorers || [],
  };
  const gates: Record<string, unknown> = {};
  for (const key of ['min_pass_rate', 'max_drop', 'max_task_cost_increase', 'max_judge_cost_increase', 'max_latency_increase', 'baseline_experiment_id'] as const) {
    if (report[key] != null) gates[key] = report[key];
  }
  if (Object.keys(gates).length) body.gates = gates;
  return body;
}

function selectedNames(scorers: unknown[] = []): string[] {
  return scorers.map((item) => String(item).replace(/^local:/, ''));
}

function questionDefinition(score: GateScore): string[] {
  const questions = score?.config?.questions;
  const raw: unknown[] = Array.isArray(questions) ? (questions as unknown[]) : [];
  const keys: string[] = [];
  for (const question of raw) {
    const key = question && typeof question === 'object' ? (question as { key?: unknown }).key : undefined;
    if (key != null) keys.push(String(key));
    else if (typeof question === 'string') keys.push(question);
  }
  return keys;
}

export function reportFromRows(
  rows: GateRow[],
  informational: string[] = [],
  itemIds?: unknown[],
  scorers?: unknown[],
): ScorerSummary[] {
  const info = new Set(informational);
  const ids = itemIds ? itemIds.map(String) : [];
  if (!itemIds) {
    for (const row of rows || []) {
      if (row?.item_id != null) ids.push(String(row.item_id));
    }
  }
  const uniqueIds = [...new Set(ids)];
  const duplicateItems = ids.length !== uniqueIds.length;
  type Observation = { itemId: string; key: string | null; unit: GateScore; score: GateScore };
  const observations = new Map<string, Observation[]>();
  const idToName = new Map<string, string>();
  const byName = new Map<string, Observation[]>();
  for (const row of rows || []) {
    if (row?.item_id == null) continue;
    const itemId = String(row.item_id);
    for (const panel of row.panels || []) {
      for (const score of panel.scores || []) {
        const questions =
          Array.isArray(score.questions) && score.questions.length ? (score.questions as GateScore[]) : null;
        if (score.role === 'summary' && !questions) continue;
        const name = String(score.scorer_name || score.name || '');
        const scorerId = String(score.scorer_id || '');
        if (!name && !scorerId) continue;
        if (scorerId && name) idToName.set(scorerId, name);
        const bucket = name || scorerId;
        const units = questions || [score];
        for (const unit of units) {
          if (!unit || unit.role === 'summary') continue;
          const key = questions && unit.key != null ? String(unit.key) : null;
          const list = byName.get(bucket) || [];
          list.push({ itemId, key, unit, score });
          byName.set(bucket, list);
        }
      }
    }
  }
  const selected = selectedNames(scorers || []);
  const used = new Set<string>();
  const order: string[] = [];
  for (const token of selected) {
    const canonical = idToName.get(token) || token;
    if (used.has(canonical)) continue;
    used.add(canonical);
    order.push(canonical);
    observations.set(canonical, [...(byName.get(canonical) || [])]);
  }
  for (const [name, seen] of byName) {
    if (!used.has(name)) {
      order.push(name);
      observations.set(name, seen);
    }
  }
  const infoNames = new Set([...info].map((token) => idToName.get(token) || token));
  const out: ScorerSummary[] = [];
  for (const name of order) {
    const seen = observations.get(name) || [];
    const configSets: string[][] = [];
    const returnedKeys: string[] = [];
    const hashes: string[] = [];
    const identities: string[] = [];
    const scorerIds: string[] = [];
    for (const obs of seen) {
      const keys = questionDefinition(obs.score);
      if (keys.length) configSets.push(keys);
      if (obs.key != null) returnedKeys.push(obs.key);
      if (obs.score.definition_hash) hashes.push(obs.score.definition_hash);
      if (obs.score.definition_identity) identities.push(obs.score.definition_identity);
      if (obs.score.scorer_id) scorerIds.push(String(obs.score.scorer_id));
    }
    const conflict = new Set(configSets.map((keys) => keys.join('\0'))).size > 1 || new Set(hashes).size > 1;
    const questionKeys = configSets.length ? configSets[0] : [...new Set(returnedKeys)];
    const counted = new Map<string, GateScore>();
    const duplicated = new Set<string>();
    for (const obs of seen) {
      const pair = `${obs.itemId}\0${obs.key}`;
      if (counted.has(pair)) duplicated.add(pair);
      else counted.set(pair, obs.unit);
    }
    const emit = (rowName: string, pairs: string[]) => {
      let completed = 0;
      let errored = 0;
      let passes = 0;
      for (const pair of pairs) {
        const unit = counted.get(pair);
        if (!unit) continue;
        const value = unit.score;
        const finiteScore = typeof value === 'number' && Number.isFinite(value);
        let status = unit.status;
        if (status == null && finiteScore && typeof unit.passed === 'boolean') status = 'judged';
        if (status === 'judged' && finiteScore && typeof unit.passed === 'boolean') {
          completed += 1;
          if (unit.passed) passes += 1;
        } else errored += 1;
      }
      const missing = pairs.filter((pair) => !counted.has(pair)).length;
      const expected = pairs.length;
      const duplicate = duplicateItems || pairs.some((pair) => duplicated.has(pair));
      const incomplete = errored || missing || duplicate || completed !== expected;
      const parent = rowName.split(':')[0];
      const row: ScorerSummary = {
        name: rowName,
        expected,
        completed,
        missing,
        errored,
        duplicate,
        passes,
        pass_rate: incomplete || !completed ? null : passes / completed,
        informational: info.has(parent) || infoNames.has(parent) || info.has(rowName) || infoNames.has(rowName),
        definition_hash: conflict || !hashes.length ? null : hashes[0],
        definition_conflict: conflict,
        definition_identity: identities[0],
      };
      if (scorerIds.length) row.scorer_id = scorerIds[0];
      out.push(row);
    };
    if (questionKeys.length) {
      for (const key of questionKeys) emit(`${name}:${key}`, uniqueIds.map((itemId) => `${itemId}\0${key}`));
    } else {
      emit(name, uniqueIds.map((itemId) => `${itemId}\0null`));
    }
  }
  return out;
}

function relativeIncrease(baseline: number, candidate: number): number {
  if (baseline === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (candidate - baseline) / baseline;
}

function judgeMeasurements(scores: GateScore[]) {
  const invocations = new Map<string, number>();
  const hashes: string[] = [];
  let missing = false;
  let sawModel = false;
  for (const score of scores || []) {
    if (!score) continue;
    if (score.key != null && !score.invocation) continue;
    const isModel = score.type === 'llm_judge' || score.type === 'jev' || Boolean(score.invocation);
    if (score.role === 'summary' && !isModel) continue;
    if (!isModel) continue;
    sawModel = true;
    if (score.definition_hash) hashes.push(String(score.definition_hash));
    const invocation = score.invocation;
    if (!invocation?.id || !finite(invocation.cost_usd)) missing = true;
    else invocations.set(String(invocation.id), Number(invocation.cost_usd));
  }
  return {
    coverage: !sawModel || !missing ? 'complete' : 'partial',
    hashes: [...new Set(hashes)].sort(),
    invocations,
  };
}

function candidateMeasurements(rows: GateRow[]) {
  let taskUsd = 0;
  let taskCoverage = 'complete';
  let sawTask = false;
  const latencies: number[] = [];
  let latencyIncomplete = !rows?.length;
  let judgeCoverage = 'complete';
  const invocations = new Map<string, number>();
  const judgeHashes: string[] = [];
  for (const row of rows || []) {
    const panel = row?.panels?.[0];
    if (!panel) {
      taskCoverage = 'unknown';
      latencyIncomplete = true;
      continue;
    }
    const taskCost = panel.task_cost;
    if (taskCost?.coverage === 'complete' && finite(taskCost.usd)) {
      taskUsd += taskCost.usd;
      sawTask = true;
    } else if (taskCost?.coverage === 'partial') {
      taskCoverage = 'partial';
      sawTask = true;
    } else if (!taskCost && finite(panel.cost_usd)) {
      taskUsd += panel.cost_usd;
      sawTask = true;
    } else if (taskCoverage === 'complete') taskCoverage = 'unknown';
    if (finite(panel.latency_ms)) latencies.push(panel.latency_ms);
    else latencyIncomplete = true;
    const judge = judgeMeasurements(panel.scores || []);
    judgeHashes.push(...judge.hashes);
    if (judge.coverage !== 'complete') judgeCoverage = 'partial';
    for (const [key, cost] of judge.invocations) invocations.set(key, cost);
  }
  if (!sawTask) taskCoverage = 'unknown';
  let judgeUsd = 0;
  for (const cost of invocations.values()) judgeUsd += cost;
  return {
    task_cost_usd: taskCoverage === 'complete' ? taskUsd : null,
    task_cost_coverage: taskCoverage,
    judge_cost_usd: judgeCoverage === 'complete' ? judgeUsd : null,
    judge_cost_coverage: judgeCoverage,
    judge_definition_hashes: [...new Set(judgeHashes)].sort(),
    mean_latency_ms: latencies.length && !latencyIncomplete ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    latency_incomplete: latencyIncomplete || latencies.length === 0,
  };
}

function rememberEvidence(bucket: Map<string, ScorerEvidence>, key: string, item: ScorerEvidence) {
  const previous = bucket.get(key);
  if (previous && (previous.verified !== true || item.verified !== true)) bucket.set(key, { ...item, verified: false });
  else bucket.set(key, item);
}

type EvidenceIndex = { byId: Map<string, ScorerEvidence>; byName: Map<string, ScorerEvidence> };

function evidenceIndex(baseline: GateBaseline): EvidenceIndex {
  const panel = baseline?.panel_index;
  const byId = new Map<string, ScorerEvidence>();
  const byName = new Map<string, ScorerEvidence>();
  for (const item of baseline?.scorer_evidence || []) {
    if (!item) continue;
    if (panel != null && Number(item.panel_index || 0) !== Number(panel)) continue;
    const scorerId = String(item.scorer_id || '');
    const name = String(item.name || '');
    if (scorerId) rememberEvidence(byId, scorerId, item);
    if (name) rememberEvidence(byName, name, item);
  }
  return { byId, byName };
}

function evidenceForScorer(index: EvidenceIndex, scorer: ScorerSummary | undefined): ScorerEvidence | undefined {
  if (!scorer) return undefined;
  const scorerId = String(scorer.scorer_id || '');
  if (scorerId) return index.byId.get(scorerId);
  const name = String(scorer.name || '');
  return name ? index.byName.get(name) : undefined;
}

function baselineRow(scorers: ScorerSummary[], name: unknown, scorerId?: unknown): ScorerSummary | undefined {
  let byName: ScorerSummary | undefined;
  const idMatches: ScorerSummary[] = [];
  const wanted = String(scorerId || '');
  for (const item of scorers || []) {
    if (!item) continue;
    if (!byName && String(item.name || '') === String(name || '')) byName = item;
    const itemId = String(item.scorer_id || '');
    if (wanted && itemId && itemId === wanted) idMatches.push(item);
  }
  if (byName) return byName;
  if (idMatches.length === 1 && !String(name || '').includes(':')) return idMatches[0];
  return undefined;
}

function baselineRowsForName(scorers: ScorerSummary[], name: string, scorerId?: unknown): ScorerSummary[] {
  const prefix = `${name}:`;
  const children = (scorers || []).filter((item) => item && String(item.name || '').startsWith(prefix));
  if (children.length) return children;
  const row = baselineRow(scorers, name, scorerId);
  return row ? [row] : [];
}

export function validateBaseline(baseline: GateBaseline | null | undefined, options: GateOptions) {
  if (!options.baseline_prompt && !options.baseline_experiment) return null;
  if (!baseline || baseline.missing) return fail(2, 'baseline_missing', 'Baseline was not found');
  if (baseline.panel_required || (baseline.panel_index != null && baseline.panel_index < 0)) {
    return fail(2, 'bad_flags', 'Choose a baseline panel');
  }
  if (baseline.dataset_verified !== true) return fail(2, 'dataset_unverified', 'The baseline dataset is not verified');
  const evidence = evidenceIndex(baseline);
  const informational = new Set(options.informational || []);
  const names = selectedNames(options.scorers || []).filter((name) => !informational.has(name));
  const ids = options.scorer_ids || {};
  const unhashed = new Set((options.unhashed_scorers || []).map((name) => String(name)));
  if (options.max_drop != null) {
    for (const name of names) {
      // A local function has no definition hash. Let the run finish so the
      // gate can report that, instead of a baseline problem that hides it.
      if (unhashed.has(name)) continue;
      const matches = baselineRowsForName(baseline.scorers, name, ids[name]);
      if (!matches.length || matches.some((item) => !finite(item.pass_rate))) {
        return fail(2, 'baseline_missing', `${name} has no baseline pass rate`);
      }
      for (const base of matches) {
        const ev = evidenceForScorer(evidence, base);
        if (!ev || ev.verified !== true) return fail(2, 'scorer_unverified', `${name} is not verified on the baseline`);
      }
    }
  }
  if (options.max_task_cost_increase != null && (baseline.task_cost_coverage !== 'complete' || !finite(baseline.task_cost_usd))) {
    return fail(2, 'baseline_missing', 'Baseline task cost is incomplete');
  }
  if (options.max_judge_cost_increase != null && (baseline.judge_cost_coverage !== 'complete' || !finite(baseline.judge_cost_usd))) {
    return fail(2, 'baseline_missing', 'Baseline judge cost is incomplete');
  }
  if (options.max_latency_increase != null && !finite(baseline.mean_latency_ms)) {
    return fail(2, 'baseline_missing', 'Baseline latency is incomplete');
  }
  return null;
}

export function applyBaseline(report: GateReport, baseline: GateBaseline | null | undefined): void {
  if (!baseline || baseline.missing || baseline.panel_required) return;
  const comparing = (['max_drop', 'max_task_cost_increase', 'max_judge_cost_increase', 'max_latency_increase'] as const).some(
    (key) => report[key] != null,
  );
  if (comparing && (!baseline.dataset_fingerprint || !report.dataset_fingerprint || baseline.dataset_fingerprint !== report.dataset_fingerprint)) {
    report.dataset_changed = true;
  }
  const evidence = evidenceIndex(baseline);
  for (const scorer of report.scorers || []) {
    const base = baselineRow(baseline.scorers, scorer.name, scorer.scorer_id);
    const ev = evidenceForScorer(evidence, base || scorer);
    if (report.max_drop != null && !scorer.informational && (!ev || ev.verified !== true)) scorer.verified = false;
    if (!base) continue;
    scorer.baseline_pass_rate = base.pass_rate;
    if (base.definition_hash) scorer.baseline_definition_hash = base.definition_hash;
    if (base.definition_hash && scorer.definition_hash && base.definition_hash !== scorer.definition_hash) {
      report.scorer_definition_changed = true;
    }
    if (scorer.definition_conflict) report.scorer_definition_changed = true;
  }
  const measured = candidateMeasurements(report.rows || []);
  if (report.max_task_cost_increase != null) {
    report.cost_gate = true;
    report.cost_coverage = measured.task_cost_coverage;
    if (
      measured.task_cost_coverage === 'complete' &&
      baseline.task_cost_coverage === 'complete' &&
      finite(measured.task_cost_usd) &&
      finite(baseline.task_cost_usd)
    ) {
      report.task_cost_increase = relativeIncrease(baseline.task_cost_usd, measured.task_cost_usd);
    }
  }
  if (report.max_judge_cost_increase != null) {
    const baseHashes = [...(baseline.judge_definition_hashes || [])].sort();
    if (baseHashes.join('\0') !== measured.judge_definition_hashes.join('\0')) report.judge_workload_mismatch = true;
    else if (
      measured.judge_cost_coverage === 'complete' &&
      baseline.judge_cost_coverage === 'complete' &&
      finite(measured.judge_cost_usd) &&
      finite(baseline.judge_cost_usd)
    ) {
      report.judge_cost_increase = relativeIncrease(baseline.judge_cost_usd, measured.judge_cost_usd);
    }
  }
  if (report.max_latency_increase != null) {
    report.latency_gate = true;
    if (
      baseline.latency_concurrency == null ||
      report.latency_concurrency == null ||
      Number(baseline.latency_concurrency) !== Number(report.latency_concurrency)
    ) {
      report.latency_concurrency_mismatch = true;
    }
    if (measured.latency_incomplete || !finite(measured.mean_latency_ms) || !finite(baseline.mean_latency_ms)) {
      report.latency_incomplete = true;
    } else {
      report.latency_increase = relativeIncrease(baseline.mean_latency_ms, measured.mean_latency_ms);
    }
  }
}

export function commentBody(summary: Partial<Pick<GateOutcome, 'label' | 'failures'>>, commentKey: string): string {
  const lines = [`<!-- traccia-eval:${commentKey} -->`, `**${summary.label || 'Failed'}**`];
  for (const failure of summary.failures || []) {
    lines.push(`- \`${failure.code}\` ${failure.message}`);
  }
  return `${lines.join('\n')}\n`;
}
