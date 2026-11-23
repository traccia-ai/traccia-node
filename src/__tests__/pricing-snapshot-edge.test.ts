/**
 * TRC-284 edge cases: input robustness, provider id formats, cache rates,
 * override/cache precedence, snapshot integrity, the snapshot refresh script,
 * and bounded resolver state. Uses the real data/pricing_snapshot.json.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BUNDLED_SNAPSHOT_FILE, loadPricingWithSource, readBundledSnapshot } from '../config/pricing-config';
import { CostResolver, MODEL_ALIASES, modelCandidates } from '../processor/cost-resolver';

type Rates = { prompt?: number; completion?: number; cached_prompt?: number; cache_write?: number; _provider?: string };

const REPO_ROOT = path.join(__dirname, '..', '..');
const snapshotJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', BUNDLED_SNAPSHOT_FILE), 'utf-8'));
const rates = snapshotJson.models as Record<string, Rates>;

describe('TRC-284 edge cases', () => {
  let resolver: CostResolver;

  beforeAll(() => {
    resolver = new CostResolver(snapshotJson.models, 'bundled', snapshotJson.generated_at);
  });

  describe('input robustness', () => {
    it.each([null, undefined, 0, 42, {}, [], true])('does not throw on non-string model %p', (model) => {
      expect(() => resolver.compute(model as unknown as string, 1000, 1000)).not.toThrow();
      expect(resolver.compute(model as unknown as string, 1000, 1000)).toBeUndefined();
    });

    it('returns undefined for zero tokens rather than a $0 cost', () => {
      expect(resolver.compute('gpt-4o-mini', 0, 0)).toBeUndefined();
    });

    it('handles mixed case and padding on aliases', () => {
      expect(resolver.matchPricingModelKey('  CLAUDE-SONNET-4-0 ')).toBe('claude-sonnet-4-20250514');
    });

    it('does not strip dates that are not a trailing suffix', () => {
      expect(modelCandidates('gpt-4o-mini-2024-07-18-ft')).toEqual(['gpt-4o-mini-2024-07-18-ft']);
      expect(resolver.matchPricingModelKey('gpt-4o-mini-2024-07-18-ft')).toBeUndefined();
    });
  });

  describe('provider id formats', () => {
    it('keeps a provider-specific price when the provider key exists (azure/gpt-4o-mini)', () => {
      expect(resolver.matchPricingModelKey('azure/gpt-4o-mini')).toBe('azure/gpt-4o-mini');
      expect(resolver.compute('azure/gpt-4o-mini', 1000, 0)).toBeCloseTo(rates['azure/gpt-4o-mini'].prompt!, 12);
    });

    it('prices Bedrock ids exactly, including region prefixes', () => {
      expect(resolver.matchPricingModelKey('anthropic.claude-3-opus-20240229-v1:0')).toBe('anthropic.claude-3-opus-20240229-v1:0');
      expect(resolver.matchPricingModelKey('us.anthropic.claude-3-7-sonnet-20250219-v1:0')).toBe(
        'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
      );
      // With a provider path the shared matcher drops the region and takes the shortest Bedrock
      // key; the regional and non-regional keys have the same rates, so check those instead.
      const regional = rates['us.anthropic.claude-3-7-sonnet-20250219-v1:0'];
      const key = resolver.matchPricingModelKey('bedrock/us.anthropic.claude-3-7-sonnet-20250219-v1:0');
      expect(key).toBeDefined();
      expect(String(rates[key!]._provider)).toMatch(/^bedrock/);
      expect(rates[key!].prompt).toBe(regional.prompt);
      expect(rates[key!].completion).toBe(regional.completion);
    });

    it('prices Vertex @date ids at the same rate as the first-party dated id', () => {
      // The shared matcher takes Vertex's own @-dated key; its rates equal the first-party dated
      // id's, so check the rates rather than which of the two keys was used.
      const key = resolver.matchPricingModelKey('claude-3-7-sonnet@20250219');
      expect(key).toBeDefined();
      expect(rates[key!].prompt).toBe(rates['claude-3-7-sonnet-20250219'].prompt);
      expect(rates[key!].completion).toBe(rates['claude-3-7-sonnet-20250219'].completion);
      const vertex = rates['vertex_ai/claude-3-7-sonnet@20250219'];
      expect(resolver.compute('claude-3-7-sonnet@20250219', 1000, 1000)).toBeCloseTo(vertex.prompt! + vertex.completion!, 12);
    });

    it('combines provider prefix and dated suffix', () => {
      expect(resolver.matchPricingModelKey('openai/gpt-4o-mini-2031-01-01')).toBe('gpt-4o-mini');
    });

    it('keeps preview/audio variants apart from their base model', () => {
      expect(resolver.matchPricingModelKey('gpt-4o-audio-preview')).toBe('gpt-4o-audio-preview');
      const r = new CostResolver({ 'gpt-4o': { inputCost: 0.0025, outputCost: 0.01 } });
      expect(r.matchPricingModelKey('gpt-4o-audio-preview')).toBeUndefined();
      expect(r.matchPricingModelKey('gpt-4o-mini')).toBeUndefined();
    });
  });

  describe('cache pricing on the real snapshot', () => {
    it('uses Anthropic cache_write and cached_prompt rates', () => {
      const r = rates['claude-sonnet-4-5'];
      const d = resolver.computeDetailed('claude-sonnet-4-5', 1000, 1000, 1000, 1000)!;
      expect(d.cost).toBeCloseTo(r.prompt! + r.completion! + r.cached_prompt! + r.cache_write!, 12);
      expect(d.cacheFallback).toBe(false);
    });

    it('flags cache fallback when the model has no cache_write rate', () => {
      const d = resolver.computeDetailed('gpt-4o-mini', 0, 0, 0, 1000)!;
      expect(d.cacheFallback).toBe(true);
      expect(d.cost).toBeCloseTo(rates['gpt-4o-mini'].prompt!, 12);
    });
  });

  describe('override and cache precedence', () => {
    const originalCacheDir = process.env.TRACCIA_CACHE_DIR;

    beforeEach(() => {
      process.env.TRACCIA_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-trc284-'));
    });

    afterAll(() => {
      if (originalCacheDir === undefined) delete process.env.TRACCIA_CACHE_DIR;
      else process.env.TRACCIA_CACHE_DIR = originalCacheDir;
    });

    const writeCache = (body: string): void =>
      fs.writeFileSync(path.join(process.env.TRACCIA_CACHE_DIR!, 'pricing.json'), body);

    it('an override rate for an existing model wins over the snapshot', async () => {
      const [pricing, source] = await loadPricingWithSource({ 'gpt-4o-mini': { inputCost: 1, outputCost: 1 } });
      expect(source).toBe('override');
      expect(new CostResolver(pricing).compute('gpt-4o-mini', 1000, 1000)).toBe(2);
    });

    it('a short override key does not capture longer model names', async () => {
      const [pricing] = await loadPricingWithSource({ 'my-llm': { inputCost: 1, outputCost: 1 } });
      const r = new CostResolver(pricing);
      expect(r.matchPricingModelKey('my-llm')).toBe('my-llm');
      expect(r.matchPricingModelKey('my-llm-large')).toBeUndefined();
    });

    it('override wins over local cache, which wins over the snapshot', async () => {
      writeCache(
        JSON.stringify({
          generated_at: '2026-09-01T00:00:00Z',
          models: { 'gpt-4o-mini': { inputCost: 5, outputCost: 5 }, 'gpt-4o': { inputCost: 7, outputCost: 7 } },
        }),
      );
      const [pricing, source, generatedAt] = await loadPricingWithSource({ 'gpt-4o': { inputCost: 9, outputCost: 9 } });
      const r = new CostResolver(pricing);
      expect(source).toBe('override');
      expect(generatedAt).toBe('2026-09-01T00:00:00Z');
      expect(r.compute('gpt-4o', 1000, 0)).toBe(9);
      expect(r.compute('gpt-4o-mini', 1000, 0)).toBe(5);
      expect(r.compute('gpt-4.1', 1000, 0)).toBeCloseTo(rates['gpt-4.1'].prompt!, 12);
    });

    it('a corrupt local cache falls back to the snapshot', async () => {
      writeCache('{oops');
      const [, source, generatedAt] = await loadPricingWithSource();
      expect(source).toBe('bundled');
      expect(generatedAt).toBe(snapshotJson.generated_at);
    });

    it('does not mutate the snapshot when merging cache and override', async () => {
      const before = { ...readBundledSnapshot()!.models['gpt-4o-mini'] };
      await loadPricingWithSource({ 'gpt-4o-mini': { inputCost: 1, outputCost: 1 } });
      expect(readBundledSnapshot()!.models['gpt-4o-mini']).toEqual(before);
    });
  });

  describe('snapshot integrity', () => {
    it('every entry has finite, non-negative per-1K rates', () => {
      const bad: string[] = [];
      for (const [key, r] of Object.entries(rates)) {
        for (const field of ['prompt', 'completion', 'cached_prompt', 'cache_write'] as const) {
          const v = r[field];
          if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) bad.push(`${key}.${field}`);
        }
        if (r.prompt === undefined && r.completion === undefined) bad.push(`${key} (no price)`);
      }
      expect(bad).toEqual([]);
    });

    it('stores rates per 1K tokens (gpt-4o-mini input is $0.15 / 1M)', () => {
      expect(rates['gpt-4o-mini'].prompt).toBeCloseTo(0.00015, 12);
      expect(rates['gpt-4o-mini'].completion).toBeCloseTo(0.0006, 12);
    });

    it('every alias whose target ships in the snapshot resolves to it', () => {
      for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
        if (target in rates) {
          expect({ alias, key: resolver.matchPricingModelKey(alias) }).toEqual({ alias, key: target });
        }
      }
    });
  });

  describe('snapshot refresh script', () => {
    // The script copies traccia-py's snapshot; its sanity check decides whether a copy is written.
    const runCheck = (models: unknown, previous: unknown): string => {
      const script = path.join(REPO_ROOT, 'scripts', 'build-pricing-snapshot.mjs');
      const url = 'file:///' + script.replace(/\\/g, '/').replace(/^\/+/, '');
      const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-check-')), 'in.json');
      fs.writeFileSync(fixture, JSON.stringify({ models, previous }));
      return execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { check } = await import(${JSON.stringify(url)});
           const { models, previous } = JSON.parse((await import('node:fs')).readFileSync(${JSON.stringify(fixture)}, 'utf-8'));
           try { check(models, previous); console.log('ok'); } catch (e) { console.log(e.message); }`,
        ],
        { encoding: 'utf-8' },
      ).trim();
    };

    it('accepts the shipped snapshot', () => {
      expect(runCheck(rates, rates)).toBe('ok');
    });

    it('rejects a snapshot that lost key models or most of its models', () => {
      const small = { 'gpt-4o': rates['gpt-4o'] };
      const message = runCheck(small, rates);
      expect(message).toContain('sanity check failed');
      expect(message).toContain('only 1 models');
      expect(message).toContain('model count fell');
      expect(message).toContain('gpt-4o-mini is missing');
    });
  });

  describe('bounded state and performance', () => {
    const indexSize = (r: CostResolver): number => {
      // The fallback lookup's indexes; the shared matcher's index is per table, not per name.
      const internals = r as unknown as { lowerIndex?: Map<string, string>; tailIndex?: Map<string, string> };
      return (internals.lowerIndex?.size ?? 0) + (internals.tailIndex?.size ?? 0);
    };

    it('lookups of many unique model names do not grow resolver state', () => {
      const r = new CostResolver(snapshotJson.models);
      r.matchPricingModelKey('ft:warm-up'); // a miss: the fallback lookup builds its indexes
      const before = indexSize(r);
      for (let i = 0; i < 5000; i++) r.matchPricingModelKey(`ft:custom-model-${i}`);
      expect(indexSize(r)).toBe(before);
    });

    it('resolves 20,000 lookups against the full snapshot quickly', () => {
      const r = new CostResolver(snapshotJson.models);
      const names = ['gpt-4o-mini', 'claude-sonnet-4-0', 'unknown-model', 'openai/gpt-4o-2031-01-01', 'claude-3-7-sonnet@20250219'];
      const start = Date.now();
      for (let i = 0; i < 20000; i++) r.compute(names[i % names.length] + (i % 7 === 0 ? `-x${i}` : ''), 100, 100);
      expect(Date.now() - start).toBeLessThan(3000);
    });

    it('rebuilds indexes after update() so new keys resolve case-insensitively', () => {
      const r = new CostResolver({ a: { inputCost: 1, outputCost: 1 } });
      expect(r.matchPricingModelKey('A')).toBe('a');
      r.update({ 'New-Model': { inputCost: 1, outputCost: 1 } });
      expect(r.matchPricingModelKey('A')).toBeUndefined();
      expect(r.matchPricingModelKey('new-model')).toBe('New-Model');
    });
  });
});
