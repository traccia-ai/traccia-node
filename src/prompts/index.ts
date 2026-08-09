/**
 * Prompt runtime helpers: loadPrompt, prefetchPrompts.
 */

import { PromptCache } from './cache';
import {
  fetchPromptRuntime,
  PromptFetchError,
  setPromptApiBase,
  getPromptApiBase,
} from './client';
import { CompileError, LoadedPrompt } from './prompt';

export type FetchImpl = (
  name: string,
  opts?: { label?: string | null; version?: number | null },
) => Promise<{ payload: Record<string, unknown>; etag?: string }>;

const DEFAULT_TTL_S = 60;
const cache = new PromptCache(DEFAULT_TTL_S);
let cacheTtlS = DEFAULT_TTL_S;
let fetchImpl: FetchImpl = (name, opts) => fetchPromptRuntime(name, opts);

export function configurePrompts(opts: {
  cacheTtlS?: number;
  promptApiBase?: string | null;
}): void {
  if (opts.cacheTtlS != null) {
    cacheTtlS = opts.cacheTtlS;
    cache.ttlSeconds = cacheTtlS;
  }
  if (opts.promptApiBase !== undefined) {
    setPromptApiBase(opts.promptApiBase);
  }
}

export { getPromptApiBase };

export function resetPromptCache(): void {
  cache.clear();
}

export function _setFetchImplForTests(fn: FetchImpl): void {
  fetchImpl = fn;
}

export function _resetFetchImplForTests(): void {
  fetchImpl = (name, opts) => fetchPromptRuntime(name, opts);
}

export interface LoadPromptOptions {
  name: string;
  label?: string;
  version?: number;
  fallback?: Record<string, unknown>;
  forceRefresh?: boolean;
}

export async function loadPrompt(options: LoadPromptOptions): Promise<LoadedPrompt> {
  const { name, version, fallback, forceRefresh } = options;
  const resolvedLabel = version != null ? null : options.label ?? 'production';
  const key = cache.makeKey(name, { label: resolvedLabel, version });

  const doFetch = () => fetchImpl(name, { label: resolvedLabel, version });

  if (!forceRefresh) {
    const cached = cache.get(key);
    if (cached) {
      if (cached.isFresh) {
        return LoadedPrompt.fromPayload(cached.entry.payload, { isStale: false });
      }
      cache.staleWhileRevalidate(key, doFetch);
      console.info(`[traccia.prompts] prompt_stale_served: serving cached prompt for ${key}`);
      return LoadedPrompt.fromPayload(cached.entry.payload, { isStale: true });
    }
  }

  try {
    const { payload, etag } = await doFetch();
    cache.set(key, payload, etag);
    return LoadedPrompt.fromPayload(payload, { isStale: false });
  } catch (err) {
    const cached = cache.get(key);
    if (cached) {
      console.warn(`[traccia.prompts] prompt_stale_served: fetch failed; using last good cache`, err);
      return LoadedPrompt.fromPayload(cached.entry.payload, { isStale: true });
    }
    if (fallback) {
      console.warn(`[traccia.prompts] loadPrompt fallback used for '${name}':`, err);
      return LoadedPrompt.fromFallback(name, fallback, resolvedLabel);
    }
    if (err instanceof PromptFetchError) throw err;
    throw new PromptFetchError(String(err));
  }
}

export async function prefetchPrompts(
  names: string[],
  opts?: { label?: string; jitterMs?: number },
): Promise<LoadedPrompt[]> {
  const label = opts?.label ?? 'production';
  const jitterMs = opts?.jitterMs ?? 1000;
  const results: LoadedPrompt[] = [];
  for (let i = 0; i < names.length; i++) {
    if (i > 0 && jitterMs > 0) {
      const delay = Math.random() * jitterMs;
      await new Promise((r) => setTimeout(r, delay));
    }
    results.push(await loadPrompt({ name: names[i], label, forceRefresh: true }));
  }
  return results;
}

export {
  LoadedPrompt,
  CompileError,
  PromptFetchError,
};
export type { PromptMessage } from './prompt';
