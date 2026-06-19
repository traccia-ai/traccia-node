/**
 * Pricing configuration management.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';

export interface PricingTable {
  [model: string]: {
    inputCost: number;
    outputCost: number;
  };
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
 * Default pricing table.
 */
export const DEFAULT_PRICING: PricingTable = {
  'gpt-3.5-turbo': {
    inputCost: 0.0005,
    outputCost: 0.0015,
  },
  'gpt-4': {
    inputCost: 0.03,
    outputCost: 0.06,
  },
  'gpt-4-turbo': {
    inputCost: 0.01,
    outputCost: 0.03,
  },
  'claude-2': {
    inputCost: 0.008,
    outputCost: 0.024,
  },
  'claude-3-opus': {
    inputCost: 0.015,
    outputCost: 0.075,
  },
};

/**
 * Load bundled pricing snapshot.
 */
export function loadBundledPricing(): PricingTable {
  // Try to load from bundled snapshot
  try {
    const bundledPath = path.join(__dirname, '..', 'data', 'pricing.json');
    if (fs.existsSync(bundledPath)) {
      const data = JSON.parse(fs.readFileSync(bundledPath, 'utf-8'));
      return data.models || DEFAULT_PRICING;
    }
  } catch {
    // Fall through to default
  }
  return DEFAULT_PRICING;
}

/**
 * Get bundled pricing generated timestamp.
 */
export function getBundledGeneratedAt(): string | null {
  try {
    const bundledPath = path.join(__dirname, '..', 'data', 'pricing.json');
    if (fs.existsSync(bundledPath)) {
      const data = JSON.parse(fs.readFileSync(bundledPath, 'utf-8'));
      return data.generated_at || null;
    }
  } catch {
    // Fall through
  }
  return null;
}

/**
 * Fetch from upstream pricing source.
 */
export async function fetchUpstreamPricing(): Promise<{ models: PricingTable; generated_at: string } | null> {
  const url = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
  try {
    const response = await axios.get(url, {
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
          models[modelId] = {
            inputCost: input_cpt ? Number((input_cpt as number) * 1000) : 0,
            outputCost: output_cpt ? Number((output_cpt as number) * 1000) : 0,
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
    const response = await axios.get(pricingUrl, {
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
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
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
  return Promise.resolve(DEFAULT_PRICING);
}

/**
 * Load pricing configuration with source tracking.
 */
export async function loadPricingWithSource(
  override?: PricingTable
): Promise<[PricingTable, PricingSource, string]> {
  let pricing = loadBundledPricing();
  let source: PricingSource = 'bundled';
  let generatedAt = getBundledGeneratedAt() || new Date().toISOString();

  const localCache = getLocalCacheInfo();
  if (localCache && localCache.models) {
    pricing = { ...pricing, ...localCache.models };
    source = 'local_cache';
    generatedAt = localCache.generated_at;
  }

  if (override) {
    pricing = { ...pricing, ...override };
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
