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
      return { models, generatedAt: validTimestamp(data.generated_at), path: candidate };
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
 * Fetch from upstream pricing source.
 */
export async function fetchUpstreamPricing(): Promise<{ models: PricingTable; generated_at: string } | null> {
  const url = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
  try {
    const response = await axios.get<Record<string, unknown>>(url, {
      headers: { "User-Agent": "traccia-cli/1.0" },
      timeout: 10000,
    });
    const raw = response.data;
    const models: PricingTable = {};
    for (const [modelId, entry] of Object.entries(raw)) {
      if (typeof entry === 'object' && entry !== null) {
        const input_cpt = (entry as Record<string, unknown>).input_cost_per_token;
        const output_cpt = (entry as Record<string, unknown>).output_cost_per_token;
        if (input_cpt !== undefined || output_cpt !== undefined) {
          const raw = entry as Record<string, unknown>;
          const cacheRead = raw.cache_read_input_token_cost;
          const cacheWrite = raw.cache_creation_input_token_cost;
          models[modelId] = {
            inputCost: input_cpt ? Number((input_cpt as number) * 1000) : 0,
            outputCost: output_cpt ? Number((output_cpt as number) * 1000) : 0,
            ...(typeof cacheRead === "number" ? { cacheReadCost: cacheRead * 1000 } : {}),
            ...(typeof cacheWrite === "number" ? { cacheWriteCost: cacheWrite * 1000 } : {}),
          };
        }
      }
    }
    return { models, generated_at: new Date().toISOString() };
  } catch {
    return null;
  }
}

/**
 * Fetch from Traccia platform.
 */
export async function fetchPlatformPricing(apiKey?: string): Promise<{ models: PricingTable; generated_at: string; etag?: string } | null> {
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

    const { ETag } = response.headers as Record<string, string>;
    return {
      models: response.data.models || {},
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
export function writeLocalCache(snapshot: { models: PricingTable; generated_at: string; etag?: string; source_url?: string }): string {
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
export function getLocalCacheInfo(): { path: string; model_count: number; generated_at: string; etag?: string; source?: string; source_url?: string; models?: PricingTable } | null {
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
