/**
 * Bounded, run-scoped evidence the PEP sends with policy checks.
 *
 * Evidence (last reads, retrieval counts, compiled prompts) belongs to one run:
 * one top-level govern() call (nested calls join it), so separate runs never share
 * evidence even under one parent trace. Outside govern() the local request root
 * (trace id + local root span id) is the run. Entries are dropped when the local
 * root span ends, and bounded by expiry and size so traces that never end here
 * cannot grow memory.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

const runScope = new AsyncLocalStorage<string>();

export const MAX_TRACES = 1024;
export const TTL_MS = 60 * 60 * 1000;
export const MAX_READS_PER_SCOPE = 64;

export class EvidenceStore<V> {
  private items = new Map<string, { ts: number; traceId: string; value: V }>();

  constructor(
    readonly maxEntries: number = MAX_TRACES,
    readonly ttlMs: number = TTL_MS,
  ) {}

  get(key: string): V | undefined {
    const item = this.items.get(key);
    if (!item) {
      return undefined;
    }
    if (Date.now() - item.ts > this.ttlMs) {
      this.items.delete(key);
      return undefined;
    }
    return item.value;
  }

  /** Replace the value at key with fn(current), refreshing its expiry. */
  update(key: string, traceId: string, fn: (current: V | undefined) => V): void {
    const current = this.get(key);
    this.items.delete(key);
    this.items.set(key, { ts: Date.now(), traceId, value: fn(current) });
    this.evict();
  }

  forgetTrace(traceId: string): void {
    for (const [key, item] of this.items) {
      if (item.traceId === traceId) {
        this.items.delete(key);
      }
    }
  }

  clear(): void {
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, item] of this.items) {
      if (this.items.size > this.maxEntries || now - item.ts > this.ttlMs) {
        this.items.delete(key);
      } else {
        break;
      }
    }
  }
}

export interface ReadEvidence {
  tool: string;
  read_at: string;
  field: string;
  resource_id?: string;
}

/** `${tenant}|${agent}|${trace}` -> `${tool}|${resource}` -> read. */
export const lastReads = new EvidenceStore<Map<string, ReadEvidence>>();
export const retrievalByTrace = new EvidenceStore<{ present?: boolean; chunk_count?: unknown }>();
export const promptByTrace = new EvidenceStore<{ name: string; label?: unknown; version_id?: unknown }>();

const STORES: Array<EvidenceStore<unknown>> = [lastReads, retrievalByTrace, promptByTrace];

export function traceKey(traceId: unknown, localRootSpanId?: unknown): string | undefined {
  if (traceId == null) {
    return undefined;
  }
  let text: string;
  if (typeof traceId === 'bigint' || (typeof traceId === 'number' && Number.isInteger(traceId))) {
    text = traceId.toString(16).padStart(32, '0');
  } else {
    text = String(traceId).trim().toLowerCase();
  }
  if (/^0*$/.test(text)) {
    return undefined;
  }
  if (localRootSpanId != null) {
    let rootText: string;
    if (typeof localRootSpanId === 'bigint' || (typeof localRootSpanId === 'number' && Number.isInteger(localRootSpanId))) {
      rootText = localRootSpanId.toString(16).padStart(16, '0');
    } else {
      rootText = String(localRootSpanId).trim().toLowerCase();
    }
    if (rootText && !/^0*$/.test(rootText)) {
      return `${text}:${rootText}`;
    }
  }
  return text;
}

/** The local request root id on a span, when it belongs to a local root boundary. */
export function spanLocalRootId(
  span?: { localRootSpanId?: unknown; isLocalRoot?: boolean; context?: { spanId?: unknown } } | null,
): string | undefined {
  if (!span) {
    return undefined;
  }
  if (span.localRootSpanId != null && span.localRootSpanId !== '') {
    return String(span.localRootSpanId);
  }
  if (span.isLocalRoot && span.context?.spanId != null && span.context.spanId !== '') {
    return String(span.context.spanId);
  }
  return undefined;
}

/** The run evidence belongs to: the enclosing govern() run, else the local request root (or trace). */
export function runKey(traceId: unknown, localRootSpanId?: unknown): string | undefined {
  return runScope.getStore() ?? traceKey(traceId, localRootSpanId);
}

function forget(run: string): void {
  for (const store of STORES) {
    store.forgetTrace(run);
  }
}

/** Drop all evidence recorded for a finished local request root (or bare trace). */
export function forgetTrace(traceId: unknown, localRootSpanId?: unknown): void {
  const key = traceKey(traceId, localRootSpanId);
  if (key) {
    forget(key);
  }
}

/** Run fn as its own run unless already inside one; the run's evidence is dropped when it settles. */
export async function governedRun<T>(fn: () => Promise<T>): Promise<T> {
  if (runScope.getStore() !== undefined) {
    return fn();
  }
  const run = `run-${randomUUID()}`;
  try {
    return await runScope.run(run, fn);
  } finally {
    forget(run);
  }
}
