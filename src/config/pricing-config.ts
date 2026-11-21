/**
 * Pricing configuration management.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';

export interface PricingRates {
  inputCost: number;
  outputCost: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  /** Platform snapshot aliases, per 1K tokens. */
  prompt?: number;
  completion?: number;
  cached_prompt?: number;
  cache_write?: number;
  /** Provider the entry belongs to, when the snapshot records it (e.g. "groq"). */
  _provider?: string;
  provider?: string;
  /** Set on entries from the user's pricingOverride, which take precedence over every other entry. */
  _override?: boolean;
}

export interface PricingTable {
  [model: string]: PricingRates;
}

/** Shape of a pricing snapshot file or platform response, as parsed from JSON. */
interface PricingFile {
  models?: PricingTable;
  generated_at?: string;
  etag?: string;
  source?: string;
  source_url?: string;
  /** LiteLLM commit the snapshot was built from. */
  source_ref?: string;
}

/** A pricing snapshot as written to the local cache. */
export interface PricingSnapshot {
  models: PricingTable;
  generated_at: string;
  etag?: string;
  source?: string;
  source_url?: string;
  source_ref?: string;
}

/** The same reviewed snapshot the SDK ships, as merged on traccia-py main. */
export const TRACCIA_PRICING_SNAPSHOT_URL =
  'https://raw.githubusercontent.com/traccia-ai/traccia-py/main/data/pricing_snapshot.json';

// Sanity checks for a pricing snapshot (same as traccia-py's check_snapshot).
const MIN_MODELS = 1000;
const MAX_MODEL_DROP = 0.1; // more than 10% of the previous models disappearing is suspicious
// Long-lived names from each major provider; update when LiteLLM retires one.
const REQUIRED_MODELS = ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'gemini/gemini-2.5-flash'];

const validPrice = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Return the problems that make a pricing snapshot unsafe to use (empty if fine).
 *
 * Every price (fields not starting with "_") must be a finite number >= 0. With
 * strict (traccia's own snapshot) it must also have at least MIN_MODELS models, keep
 * the REQUIRED_MODELS priced, and not lose more than MAX_MODEL_DROP of previous.
 */
export function checkSnapshot(models: unknown, previous?: Record<string, unknown> | null, strict = true): string[] {
  if (!models || typeof models !== 'object' || Array.isArray(models) || !Object.keys(models).length) {
    return ['no models'];
  }
  const table = models as Record<string, unknown>;
  const problems: string[] = [];
  const bad: string[] = [];
  for (const [name, rates] of Object.entries(table)) {
    if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
      bad.push(`${name} is not an object`);
      continue;
    }
    for (const [field, value] of Object.entries(rates as Record<string, unknown>)) {
      if (!field.startsWith('_') && !validPrice(value)) bad.push(`${name}.${field}=${JSON.stringify(value)}`);
    }
  }
  if (bad.length) {
    problems.push(`${bad.length} prices are not a finite number >= 0: ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? ' …' : ''}`);
  }
  if (strict) {
    const count = Object.keys(table).length;
    if (count < MIN_MODELS) problems.push(`only ${count} models (expected at least ${MIN_MODELS})`);
    if (previous) {
      const before = Object.keys(previous).length;
      if (count < before * (1 - MAX_MODEL_DROP)) problems.push(`model count fell from ${before} to ${count}`);
    }
    for (const name of REQUIRED_MODELS) {
      const rates = table[name] as Record<string, unknown> | undefined;
      if (!rates || typeof rates !== 'object' || !rates.prompt || !rates.completion) {
        problems.push(`${name} is missing or has no prompt/completion price`);
      }
    }
  }
  return problems;
}

export type PricingSource = 'default' | 'env' | 'override' | 'bundled' | 'local_cache';

/**
 * Get the local cache path for pricing.
 */
export function getCachePath(): string {
  const cacheDir = process.env.TRACCIA_CACHE_DIR || path.join(os.homedir(), '.cache', 'traccia');
  return path.join(cacheDir, 'pricing.json');
}

/**
 * Fallback used only when no snapshot can be loaded. It is intentionally empty:
 * a missing snapshot must leave models unpriced, never price them at legacy
 * hardcoded rates.
 * @deprecated Kept for backward compatibility; use loadBundledPricing().
 */
export const DEFAULT_PRICING: PricingTable = Object.freeze({}) as PricingTable;

export const BUNDLED_SNAPSHOT_FILE = 'pricing_snapshot.json';

/**
 * Candidate locations of the shipped snapshot (<package>/data/pricing_snapshot.json).
 * The bundled build runs from dist/, the sources (ts-jest, ts-node) from src/config/.
 */
export function bundledSnapshotCandidates(baseDir: string = __dirname): string[] {
  return [
    path.join(baseDir, '..', 'data', BUNDLED_SNAPSHOT_FILE),
    path.join(baseDir, '..', '..', 'data', BUNDLED_SNAPSHOT_FILE),
  ];
}

export interface BundledSnapshot {
  models: PricingTable;
  generatedAt: string | null;
  /** LiteLLM commit the snapshot was built from, when recorded. */
  sourceRef: string | null;
  path: string;
}

/**
 * Read the snapshot shipped with the SDK, or null when it is missing or invalid.
 */
export function readBundledSnapshot(): BundledSnapshot | null {
  for (const candidate of bundledSnapshotCandidates()) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const data = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as PricingFile | null;
      const models = data?.models;
      if (!models || typeof models !== 'object' || Array.isArray(models) || !Object.keys(models).length) {
        continue;
      }
      const sourceRef = typeof data.source_ref === 'string' ? data.source_ref : null;
      return { models, generatedAt: validTimestamp(data.generated_at), sourceRef, path: candidate };
    } catch {
      // Try the next candidate
    }
  }
  return null;
}

/**
 * Load bundled pricing snapshot. Returns an empty table when the snapshot is missing.
 */
export function loadBundledPricing(): PricingTable {
  return readBundledSnapshot()?.models ?? DEFAULT_PRICING;
}

/**
 * Get bundled pricing generated timestamp.
 */
export function getBundledGeneratedAt(): string | null {
  return readBundledSnapshot()?.generatedAt ?? null;
}

function validTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/**
 * Fetch traccia's reviewed pricing snapshot from GitHub (traccia-py main): the same
 * file the SDK ships. Returns null when it can't be downloaded or fails checkSnapshot.
 */
export async function fetchUpstreamPricing(): Promise<PricingSnapshot | null> {
  const url = TRACCIA_PRICING_SNAPSHOT_URL;
  let data: unknown;
  try {
    const response = await axios.get<unknown>(url, {
      headers: { 'User-Agent': 'traccia-cli/1.0' },
      timeout: 10000,
    });
    data = response.data;
  } catch (e) {
    console.error(`  Failed to download the pricing snapshot: ${String(e)}`);
    return null;
  }
  // axios leaves a body it can't parse as JSON (e.g. one containing NaN) as a string.
  const snapshot = data && typeof data === 'object' && !Array.isArray(data) ? (data as PricingFile) : {};
  const problems = checkSnapshot(snapshot.models, readBundledSnapshot()?.models);
  if (problems.length) {
    console.error(`  Downloaded pricing snapshot failed the sanity check; not saved:\n    - ${problems.join('\n    - ')}`);
    return null;
  }
  return {
    ...snapshot,
    models: snapshot.models ?? {},
    generated_at: validTimestamp(snapshot.generated_at) ?? 'unknown',
    source: 'traccia-py',
    source_url: url,
  };
}

/**
 * Fetch from Traccia platform. Returns null when unreachable, not modified, or when
 * the response has invalid prices (checkSnapshot, non-strict).
 */
export async function fetchPlatformPricing(apiKey?: string): Promise<PricingSnapshot | null> {
  const apiBase = process.env.TRACCIA_API_URL || "https://api.traccia.ai";
  const pricingUrl = `${apiBase.replace(/\/+$/, '')}/v1/pricing/latest`;

  try {
    const response = await axios.get<PricingFile>(pricingUrl, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      timeout: 5000,
    });

    if (response.status === 304) {
      return null;
    }

    const models = response.data?.models || {};
    const problems = checkSnapshot(models, null, false);
    if (problems.length) {
      console.error(`  Platform pricing is invalid; not used: ${problems.join('; ')}`);
      return null;
    }

    const { ETag } = response.headers as Record<string, string>;
    return {
      models,
      generated_at: response.data.generated_at || new Date().toISOString(),
      etag: ETag?.replace(/"/g, ''),
    };
  } catch {
    return null;
  }
}

/**
 * Write pricing to local cache.
 */
export function writeLocalCache(snapshot: PricingSnapshot): string {
  const cachePath = getCachePath();
  const cacheDir = path.dirname(cachePath);
  
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  
  fs.writeFileSync(cachePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  return cachePath;
}

/**
 * Get local cache info.
 */
export function getLocalCacheInfo(): { path: string; model_count: number; generated_at: string; etag?: string; source?: string; source_url?: string; source_ref?: string; models?: PricingTable } | null {
  const cachePath = getCachePath();
  try {
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as PricingFile;
    return {
      path: cachePath,
      model_count: Object.keys(data.models || {}).length,
      generated_at: data.generated_at,
      etag: data.etag,
      source: data.source || 'platform',
      source_url: data.source_url,
      source_ref: data.source_ref,
      models: data.models,
    };
  } catch {
    return null;
  }
}

/**
 * Clear local pricing cache.
 */
export function clearLocalCache(): boolean {
  const cachePath = getCachePath();
  try {
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

/**
 * Fetch remote pricing (placeholder).
 */
export function fetchRemotePricing(): Promise<PricingTable> {
  // In production, this would fetch from a backend service
  return Promise.resolve(loadBundledPricing());
}

/**
 * Load pricing configuration with source tracking.
 *
 * The timestamp is always the snapshot's own generated_at ('unknown' when it has
 * none), never the load time. Without a snapshot the source is 'default' and the
 * table is empty, so models stay unpriced.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- public API returns a Promise; loading is synchronous today
export async function loadPricingWithSource(
  override?: PricingTable
): Promise<[PricingTable, PricingSource, string]> {
  const bundled = readBundledSnapshot();
  let pricing: PricingTable = bundled ? { ...bundled.models } : {};
  let source: PricingSource = bundled ? 'bundled' : 'default';
  let generatedAt = bundled?.generatedAt ?? 'unknown';

  const localCache = getLocalCacheInfo();
  if (localCache && localCache.models && Object.keys(localCache.models).length) {
    pricing = { ...pricing, ...localCache.models };
    source = 'local_cache';
    generatedAt = validTimestamp(localCache.generated_at) ?? 'unknown';
  }

  if (override) {
    pricing = { ...pricing };
    for (const [model, rates] of Object.entries(override)) {
      pricing[model] = { ...rates, _override: true };
    }
    source = 'override';
  }

  return [pricing, source, generatedAt];
}

/**
 * Load pricing configuration.
 */
export async function loadPricing(override?: PricingTable): Promise<PricingTable> {
  const [pricing] = await loadPricingWithSource(override);
  return pricing;
}

/**
 * The LiteLLM commit behind the active base table: the local cache's when it is in
 * use, otherwise the bundled snapshot's. null when unknown (e.g. an older cache file).
 */
export function getActiveSourceRef(): string | null {
  const localCache = getLocalCacheInfo();
  if (localCache && localCache.models && Object.keys(localCache.models).length) {
    return localCache.source_ref ?? null;
  }
  return readBundledSnapshot()?.sourceRef ?? null;
}

/**
 * Return the age in days of a pricing snapshot (aligned with traccia-py).
 */
export function snapshotAgeDays(generatedAt: string): number | undefined {
  if (!generatedAt || generatedAt === 'unknown') {
    return undefined;
  }

  try {
    const ts = new Date(generatedAt.replace('Z', '+00:00'));
    if (Number.isNaN(ts.getTime())) {
      return undefined;
    }
    const deltaMs = Date.now() - ts.getTime();
    return deltaMs / 86_400_000;
  } catch {
    return undefined;
  }
}
