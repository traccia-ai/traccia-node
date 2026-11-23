#!/usr/bin/env node
/**
 * Refresh data/pricing_snapshot.json by copying traccia-py's snapshot, so both SDKs ship
 * exactly the same prices. traccia-py builds it from LiteLLM, pinned to one LiteLLM
 * commit (see traccia-py/scripts/build_pricing_snapshot.py).
 *
 * The snapshot is committed and shipped as-is; releases never fetch it. Run this in every
 * version bump PR, after releasing traccia-py (whose bump PR refreshes the prices), so
 * each release ships fresh, reviewed prices (npm-publish.yml refuses a snapshot older
 * than 14 days):
 *     npm run pricing:snapshot                       # traccia-py main
 *     npm run pricing:snapshot -- --ref <sha>        # a specific traccia-py commit
 *
 * The copy is pinned to one traccia-py commit (recorded as copied_from). The run fails if
 * the snapshot looks broken (too few models, key models missing or unpriced), using the
 * same checks as traccia-py.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';

const SOURCE_REPO = 'traccia-ai/traccia-py';
const SOURCE_FILE = 'data/pricing_snapshot.json';
const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'pricing_snapshot.json');

// Sanity checks (same as traccia-py): a snapshot failing these is not written.
const MIN_MODELS = 1000;
const MAX_MODEL_DROP = 0.1; // fail if more than 10% of the current models disappear
// Long-lived names from each major provider; update when LiteLLM retires one.
const REQUIRED_MODELS = ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'gemini/gemini-2.5-flash'];
const BIG_CHANGE = 0.5; // list price changes above 50% in the summary
const SHA = /^[0-9a-f]{40}$/;

async function get(url, accept) {
  const headers = { 'User-Agent': 'traccia-build/1.0' };
  if (accept) headers.Accept = accept;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

/** Turn a branch or tag of traccia-py into the full commit SHA it points at. */
export async function resolveRef(ref) {
  if (SHA.test(ref)) return ref;
  const res = await get(`https://api.github.com/repos/${SOURCE_REPO}/commits/${ref}`, 'application/vnd.github.sha');
  const sha = (await res.text()).trim();
  if (!SHA.test(sha)) throw new Error(`Could not resolve traccia-py ref '${ref}' to a commit SHA`);
  return sha;
}

/** The price fields of one model (fields starting with "_" are metadata). */
function costFields(rates) {
  return Object.fromEntries(Object.entries(rates).filter(([k]) => !k.startsWith('_')));
}

const validPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Throw if the new snapshot looks broken. */
export function check(models, previous) {
  const problems = [];
  const count = Object.keys(models).length;
  if (count < MIN_MODELS) problems.push(`only ${count} models (expected at least ${MIN_MODELS})`);
  if (previous) {
    const before = Object.keys(previous).length;
    if (count < before * (1 - MAX_MODEL_DROP)) problems.push(`model count fell from ${before} to ${count}`);
  }
  for (const name of REQUIRED_MODELS) {
    const rates = models[name];
    if (!rates || !rates.prompt || !rates.completion) {
      problems.push(`${name} is missing or has no prompt/completion price`);
    }
  }
  const bad = [];
  for (const [name, rates] of Object.entries(models)) {
    for (const [field, value] of Object.entries(costFields(rates))) {
      if (!validPrice(value)) bad.push(`${name}.${field}=${JSON.stringify(value)}`);
    }
  }
  if (bad.length) {
    problems.push(`${bad.length} prices are not a finite number >= 0: ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? ' …' : ''}`);
  }
  if (problems.length) {
    throw new Error('Pricing snapshot sanity check failed:\n  - ' + problems.join('\n  - '));
  }
}

/** Markdown summary of what changed (used as the pull request body). */
export function summarize(models, previous, sourceUrl, litellmUrl) {
  const added = Object.keys(models).filter((m) => !(m in previous));
  const removed = Object.keys(previous).filter((m) => !(m in models)).sort();
  const changed = new Set();
  const big = [];
  for (const name of Object.keys(models).filter((m) => m in previous).sort()) {
    const oldRates = costFields(previous[name]);
    const newRates = costFields(models[name]);
    for (const field of [...new Set([...Object.keys(oldRates), ...Object.keys(newRates)])].sort()) {
      const before = oldRates[field];
      const after = newRates[field];
      if (before === after) continue;
      changed.add(name);
      // A price going to or from zero is always worth a look.
      if (before !== undefined && after !== undefined && (!before || !after || Math.abs(after - before) / before > BIG_CHANGE)) {
        big.push(`| \`${name}\` | ${field} | ${before} | ${after} |`);
      }
    }
  }
  const lines = [
    `Copied from: ${sourceUrl}`,
    `LiteLLM source: ${litellmUrl}`,
    '',
    `- Models: ${Object.keys(previous).length} → ${Object.keys(models).length} (${added.length} added, ${removed.length} removed)`,
    `- Models with a changed price (any field): ${changed.size}`,
  ];
  if (removed.length) {
    const shown = removed.slice(0, 50).map((m) => `\`${m}\``).join(', ');
    lines.push(`- Removed (traces of these models will no longer get a cost): ${shown}${removed.length > 50 ? ' …' : ''}`);
  }
  if (big.length) {
    lines.push(
      '',
      `Price changes over ${BIG_CHANGE * 100}% or to/from zero (check these):`,
      '',
      '| Model | Field | Old (per 1K) | New (per 1K) |',
      '|---|---|---|---|',
      ...big.slice(0, 100),
    );
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const { values } = parseArgs({
    options: {
      ref: { type: 'string', default: 'main' },
      summary: { type: 'string' },
    },
  });

  const sha = await resolveRef(values.ref);
  const url = `https://raw.githubusercontent.com/${SOURCE_REPO}/${sha}/${SOURCE_FILE}`;
  console.log(`Fetching ${url} ...`);
  const snapshot = await (await get(url)).json();
  const models = snapshot.models;
  if (!models || typeof models !== 'object') throw new Error('traccia-py snapshot has no "models"');
  console.log(`  ${Object.keys(models).length} models (LiteLLM source: ${snapshot.source_url})`);

  const previous = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, 'utf-8')).models : null;
  check(models, previous);

  if (values.summary) {
    writeFileSync(values.summary, summarize(models, previous || {}, url, snapshot.source_url), 'utf-8');
  }
  // Written even when prices are unchanged, so generated_at matches traccia-py's (when the
  // prices were last checked against LiteLLM), which is what the release age check reads.
  if (isDeepStrictEqual(models, previous)) {
    console.log('  Prices unchanged; updating generated_at and source_ref from traccia-py');
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify({ ...snapshot, copied_from: url }, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${Object.keys(models).length} models to ${OUTPUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
