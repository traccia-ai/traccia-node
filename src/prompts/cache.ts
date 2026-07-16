/**
 * Client-side prompt cache with TTL and stale-while-revalidate.
 */

export type CacheKey = [string, string];

export interface CacheEntry {
  payload: Record<string, unknown>;
  fetchedAt: number;
  etag?: string;
}

export class PromptCache {
  private entries = new Map<string, CacheEntry>();
  private refreshing = new Set<string>();

  constructor(public ttlSeconds = 60) {}

  clear(): void {
    this.entries.clear();
    this.refreshing.clear();
  }

  private serialize(key: CacheKey): string {
    return `${key[0]}|${key[1]}`;
  }

  makeKey(name: string, opts: { label?: string | null; version?: number | null }): CacheKey {
    if (opts.version != null) {
      return [name, `version:${opts.version}`];
    }
    return [name, `label:${opts.label || 'production'}`];
  }

  get(key: CacheKey): { entry: CacheEntry; isFresh: boolean } | undefined {
    const entry = this.entries.get(this.serialize(key));
    if (!entry) return undefined;
    const age = (Date.now() - entry.fetchedAt) / 1000;
    return { entry, isFresh: age < this.ttlSeconds };
  }

  set(key: CacheKey, payload: Record<string, unknown>, etag?: string): void {
    this.entries.set(this.serialize(key), {
      payload,
      fetchedAt: Date.now(),
      etag,
    });
  }

  beginRefresh(key: CacheKey): boolean {
    const id = this.serialize(key);
    if (this.refreshing.has(id)) return false;
    this.refreshing.add(id);
    return true;
  }

  endRefresh(key: CacheKey): void {
    this.refreshing.delete(this.serialize(key));
  }

  staleWhileRevalidate(
    key: CacheKey,
    fetch: () => Promise<{ payload: Record<string, unknown>; etag?: string }>,
  ): void {
    if (!this.beginRefresh(key)) return;
    void (async () => {
      try {
        const { payload, etag } = await fetch();
        this.set(key, payload, etag);
      } catch (err) {
        console.warn(`[traccia.prompts] prompt_stale_served: background refresh failed for ${key}:`, err);
      } finally {
        this.endRefresh(key);
      }
    })();
  }
}
