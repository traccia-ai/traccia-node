jest.mock('fs');
jest.mock('axios');

import * as fs from 'fs';
import axios from 'axios';
import {
    DEFAULT_PRICING,
    getCachePath,
    loadBundledPricing,
    getBundledGeneratedAt,
    fetchUpstreamPricing,
    fetchPlatformPricing,
    writeLocalCache,
    getLocalCacheInfo,
    clearLocalCache,
    fetchRemotePricing,
    readBundledSnapshot,
    bundledSnapshotCandidates,
    loadPricingWithSource,
    loadPricing,
    snapshotAgeDays,
    checkSnapshot,
    TRACCIA_PRICING_SNAPSHOT_URL,
} from '../config/pricing-config';

describe('pricing-config', () => {
    const mockExistsSync = fs.existsSync as jest.Mock;
    const mockReadFileSync = fs.readFileSync as jest.Mock;
    const mockWriteFileSync = fs.writeFileSync as jest.Mock;
    const mockMkdirSync = fs.mkdirSync as jest.Mock;
    const mockUnlinkSync = fs.unlinkSync as jest.Mock;
    const mockAxiosGet = axios.get as jest.Mock;

    const originalCacheDir = process.env.TRACCIA_CACHE_DIR;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.TRACCIA_CACHE_DIR = '/tmp/traccia-cache-test';
    });

    afterAll(() => {
        if (originalCacheDir === undefined) {
            delete process.env.TRACCIA_CACHE_DIR;
        } else {
            process.env.TRACCIA_CACHE_DIR = originalCacheDir;
        }
    });

    describe('getCachePath', () => {
        it('uses TRACCIA_CACHE_DIR when set', () => {
            expect(getCachePath()).toBe('/tmp/traccia-cache-test/pricing.json');
        });

        it('falls back to ~/.cache/traccia when TRACCIA_CACHE_DIR is unset', () => {
            delete process.env.TRACCIA_CACHE_DIR;

            expect(getCachePath().endsWith('.cache/traccia/pricing.json') || getCachePath().endsWith('.cache\\traccia\\pricing.json')).toBe(true);
        });
    });

    describe('loadBundledPricing', () => {
        it('returns DEFAULT_PRICING when the bundled file does not exist', () => {
            mockExistsSync.mockReturnValue(false);

            expect(loadBundledPricing()).toEqual(DEFAULT_PRICING);
        });

        it('returns the bundled models when the file exists and is valid', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(
                JSON.stringify({ models: { 'gpt-5': { inputCost: 1, outputCost: 2 } }, generated_at: '2026-01-01' }),
            );

            expect(loadBundledPricing()).toEqual({ 'gpt-5': { inputCost: 1, outputCost: 2 } });
        });

        it('falls back to DEFAULT_PRICING when the bundled file has no models key', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ generated_at: '2026-01-01' }));

            expect(loadBundledPricing()).toEqual(DEFAULT_PRICING);
        });

        it('falls back to DEFAULT_PRICING when reading/parsing throws', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockImplementation(() => {
                throw new Error('EACCES');
            });

            expect(loadBundledPricing()).toEqual(DEFAULT_PRICING);
        });
    });

    describe('bundled snapshot validation (TRC-284)', () => {
        it.each([
            ['an array of models', { models: [] }],
            ['an empty models object', { models: {} }],
            ['models: null', { models: null }],
            ['a JSON array', []],
            ['a JSON string', 'pricing'],
        ])('rejects %s', (_label, body) => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(body));

            expect(readBundledSnapshot()).toBeNull();
            expect(loadBundledPricing()).toEqual({});
        });

        it('reads the snapshot under the new file name, not the legacy pricing.json', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ models: { m: { inputCost: 1, outputCost: 1 } } }));

            readBundledSnapshot();

            const read = mockReadFileSync.mock.calls.map((c) => String(c[0]));
            expect(read.length).toBeGreaterThan(0);
            expect(read.every((p) => p.endsWith('pricing_snapshot.json'))).toBe(true);
        });

        it('falls through to the next candidate when the first one is corrupt', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync
                .mockImplementationOnce(() => '{not json')
                .mockImplementationOnce(() => JSON.stringify({ models: { m: { inputCost: 1, outputCost: 1 } }, generated_at: '2026-01-01' }));

            const snap = readBundledSnapshot();

            expect(snap?.models).toEqual({ m: { inputCost: 1, outputCost: 1 } });
            expect(snap?.path).toBe(bundledSnapshotCandidates()[1]);
        });
    });

    describe('getBundledGeneratedAt', () => {
        it('returns null when the bundled file does not exist', () => {
            mockExistsSync.mockReturnValue(false);

            expect(getBundledGeneratedAt()).toBeNull();
        });

        it('returns generated_at when present', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(
                JSON.stringify({ generated_at: '2026-02-02', models: { 'gpt-5': { inputCost: 1, outputCost: 2 } } }),
            );

            expect(getBundledGeneratedAt()).toBe('2026-02-02');
        });

        it('returns null for an unparseable generated_at (TRC-284)', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(
                JSON.stringify({ generated_at: 'yesterday', models: { 'gpt-5': { inputCost: 1, outputCost: 2 } } }),
            );

            expect(getBundledGeneratedAt()).toBeNull();
        });

        it('returns null when generated_at is missing', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({}));

            expect(getBundledGeneratedAt()).toBeNull();
        });

        it('returns null when reading/parsing throws', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockImplementation(() => {
                throw new Error('bad json');
            });

            expect(getBundledGeneratedAt()).toBeNull();
        });
    });

    describe('fetchUpstreamPricing', () => {
        // The real shipped snapshot (fs is mocked in this file).
        const realFs = jest.requireActual<typeof import('fs')>('fs');
        const shipped = () =>
            JSON.parse(
                realFs.readFileSync(require('path').join(__dirname, '..', '..', 'data', 'pricing_snapshot.json'), 'utf-8'),
            ) as { models: Record<string, Record<string, unknown>>; generated_at: string };

        beforeEach(() => {
            mockExistsSync.mockReturnValue(false); // no bundled snapshot to compare against
            jest.spyOn(console, 'error').mockImplementation(() => undefined);
        });

        afterEach(() => {
            (console.error as jest.Mock).mockRestore();
        });

        it("downloads traccia's reviewed snapshot from traccia-py main", async () => {
            const snap = { ...shipped(), source_ref: 'a'.repeat(40) };
            mockAxiosGet.mockResolvedValue({ data: snap });

            const result = await fetchUpstreamPricing();

            expect(mockAxiosGet).toHaveBeenCalledWith(TRACCIA_PRICING_SNAPSHOT_URL, expect.anything());
            expect(result).not.toBeNull();
            expect(result!.models).toEqual(snap.models);
            expect(result!.source).toBe('traccia-py');
            expect(result!.source_ref).toBe('a'.repeat(40));
            expect(result!.generated_at).toBe(snap.generated_at);
        });

        it('rejects a snapshot with an invalid price', async () => {
            const snap = shipped();
            snap.models['gpt-4o'].prompt = -1;
            mockAxiosGet.mockResolvedValue({ data: snap });

            expect(await fetchUpstreamPricing()).toBeNull();
        });

        it('rejects a body that is not JSON (e.g. contains NaN)', async () => {
            mockAxiosGet.mockResolvedValue({ data: '{"models": {"gpt-4o": {"prompt": NaN}}}' });

            expect(await fetchUpstreamPricing()).toBeNull();
        });

        it('rejects a snapshot with too few models', async () => {
            mockAxiosGet.mockResolvedValue({ data: { models: { 'gpt-4o': { prompt: 1, completion: 1 } } } });

            expect(await fetchUpstreamPricing()).toBeNull();
        });

        it('returns null when the request fails', async () => {
            mockAxiosGet.mockRejectedValue(new Error('network error'));

            expect(await fetchUpstreamPricing()).toBeNull();
        });
    });

    describe('checkSnapshot', () => {
        it.each([NaN, Infinity, -1, true, '0.1', null])('rejects the price %p, strict or not', (bad) => {
            const models = { m: { prompt: 1, cached_prompt: bad } };
            expect(checkSnapshot(models, null, false).join()).toContain('not a finite number');
        });

        it('ignores metadata fields and accepts a small table when not strict', () => {
            expect(checkSnapshot({ m: { prompt: 0, _provider: 'x', _max_tokens: 'n/a' } }, null, false)).toEqual([]);
        });

        it('applies the size, drop and required-model checks when strict', () => {
            const previous = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`m${i}`, { prompt: 1 }]));
            const problems = checkSnapshot({ x: { prompt: 1, completion: 1 } }, previous).join('\n');
            expect(problems).toContain('only 1 models');
            expect(problems).toContain('model count fell');
            expect(problems).toContain('gpt-4o is missing');
            expect(checkSnapshot({})).toEqual(['no models']);
        });
    });

    describe('fetchPlatformPricing', () => {
        it('includes an Authorization header when apiKey is provided', async () => {
            mockAxiosGet.mockResolvedValue({
                status: 200,
                data: { models: { 'gpt-4': { inputCost: 1, outputCost: 2 } }, generated_at: '2026-01-01' },
                headers: {},
            });

            await fetchPlatformPricing('my-api-key');

            expect(mockAxiosGet).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ headers: { Authorization: 'Bearer my-api-key' } }),
            );
        });

        it('sends no Authorization header when apiKey is omitted', async () => {
            mockAxiosGet.mockResolvedValue({ status: 200, data: {}, headers: {} });

            await fetchPlatformPricing();

            expect(mockAxiosGet).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: {} }));
        });

        it('returns null on a 304 Not Modified response', async () => {
            mockAxiosGet.mockResolvedValue({ status: 304, data: {}, headers: {} });

            expect(await fetchPlatformPricing()).toBeNull();
        });

        it('extracts and strips quotes from the ETag header', async () => {
            mockAxiosGet.mockResolvedValue({
                status: 200,
                data: { models: { 'gpt-4': { prompt: 1, completion: 2 } }, generated_at: '2026-01-01' },
                headers: { ETag: '"abc123"' },
            });

            const result = await fetchPlatformPricing();

            expect(result!.etag).toBe('abc123');
        });

        it('defaults generated_at to now when the response omits it', async () => {
            mockAxiosGet.mockResolvedValue({ status: 200, data: { models: { 'gpt-4': { prompt: 1 } } }, headers: {} });

            const result = await fetchPlatformPricing();

            expect(typeof result!.generated_at).toBe('string');
        });

        it('returns null (so the CLI falls back to GitHub) when there are no models or a price is invalid', async () => {
            jest.spyOn(console, 'error').mockImplementation(() => undefined);
            mockAxiosGet.mockResolvedValue({ status: 200, data: {}, headers: {} });
            expect(await fetchPlatformPricing()).toBeNull();

            mockAxiosGet.mockResolvedValue({ status: 200, data: { models: { 'gpt-4': { prompt: NaN } } }, headers: {} });
            expect(await fetchPlatformPricing()).toBeNull();
            (console.error as jest.Mock).mockRestore();
        });

        it('returns null when the request fails', async () => {
            mockAxiosGet.mockRejectedValue(new Error('timeout'));

            expect(await fetchPlatformPricing()).toBeNull();
        });
    });

    describe('writeLocalCache', () => {
        it('creates the cache directory when missing, then writes the snapshot', () => {
            mockExistsSync.mockReturnValue(false);

            const result = writeLocalCache({ models: {}, generated_at: '2026-01-01' });

            expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/traccia-cache-test', { recursive: true });
            expect(mockWriteFileSync).toHaveBeenCalledWith(
                '/tmp/traccia-cache-test/pricing.json',
                expect.any(String),
                'utf-8',
            );
            expect(result).toBe('/tmp/traccia-cache-test/pricing.json');
        });

        it('does not recreate the cache directory when it already exists', () => {
            mockExistsSync.mockReturnValue(true);

            writeLocalCache({ models: {}, generated_at: '2026-01-01' });

            expect(mockMkdirSync).not.toHaveBeenCalled();
        });
    });

    describe('getLocalCacheInfo', () => {
        it('returns null when no cache file exists', () => {
            mockExistsSync.mockReturnValue(false);

            expect(getLocalCacheInfo()).toBeNull();
        });

        it('returns cache metadata when the file exists and is valid', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(
                JSON.stringify({
                    models: { 'gpt-4': { inputCost: 1, outputCost: 2 } },
                    generated_at: '2026-01-01',
                    etag: 'abc',
                    source_url: 'https://example.com',
                }),
            );

            const info = getLocalCacheInfo();

            expect(info).toMatchObject({
                model_count: 1,
                generated_at: '2026-01-01',
                etag: 'abc',
                source: 'platform',
                source_url: 'https://example.com',
            });
        });

        it('defaults source to "platform" and model_count to 0 when models is missing', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ generated_at: '2026-01-01' }));

            const info = getLocalCacheInfo();

            expect(info!.model_count).toBe(0);
            expect(info!.source).toBe('platform');
        });

        it('returns null when the cache file is malformed JSON', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('{not valid json');

            expect(getLocalCacheInfo()).toBeNull();
        });
    });

    describe('clearLocalCache', () => {
        it('deletes the cache file and returns true when it exists', () => {
            mockExistsSync.mockReturnValue(true);

            expect(clearLocalCache()).toBe(true);
            expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/traccia-cache-test/pricing.json');
        });

        it('returns false when no cache file exists', () => {
            mockExistsSync.mockReturnValue(false);

            expect(clearLocalCache()).toBe(false);
            expect(mockUnlinkSync).not.toHaveBeenCalled();
        });

        it('returns false (swallows the error) when unlink throws', () => {
            mockExistsSync.mockReturnValue(true);
            mockUnlinkSync.mockImplementation(() => {
                throw new Error('EPERM');
            });

            expect(clearLocalCache()).toBe(false);
        });
    });

    describe('loadPricingWithSource / loadPricing', () => {
        it('without a snapshot, cache or override: empty table, source "default", generatedAt "unknown" (TRC-284)', async () => {
            mockExistsSync.mockReturnValue(false);

            const [pricing, source, generatedAt] = await loadPricingWithSource();

            expect(pricing).toEqual({});
            expect(source).toBe('default');
            expect(generatedAt).toBe('unknown');
        });

        it('reports the bundled snapshot timestamp, not the load time (TRC-284)', async () => {
            mockExistsSync.mockImplementation((p: string) => String(p).endsWith('pricing_snapshot.json'));
            mockReadFileSync.mockReturnValue(
                JSON.stringify({ generated_at: '2026-04-22T15:07:43Z', models: { 'gpt-4o-mini': { prompt: 0.00015, completion: 0.0006 } } }),
            );

            const [pricing, source, generatedAt] = await loadPricingWithSource();

            expect(Object.keys(pricing)).toEqual(['gpt-4o-mini']);
            expect(source).toBe('bundled');
            expect(generatedAt).toBe('2026-04-22T15:07:43Z');
        });

        it('a bundled snapshot without generated_at reports "unknown" (TRC-284)', async () => {
            mockExistsSync.mockImplementation((p: string) => String(p).endsWith('pricing_snapshot.json'));
            mockReadFileSync.mockReturnValue(JSON.stringify({ models: { m: { inputCost: 1, outputCost: 1 } } }));

            const [, source, generatedAt] = await loadPricingWithSource();

            expect(source).toBe('bundled');
            expect(generatedAt).toBe('unknown');
        });

        it('merges local cache on top of bundled and reports source "local_cache"', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(
                JSON.stringify({
                    models: { 'custom-model': { inputCost: 5, outputCost: 10 } },
                    generated_at: '2026-03-03',
                }),
            );

            const [pricing, source, generatedAt] = await loadPricingWithSource();

            expect(pricing['custom-model']).toEqual({ inputCost: 5, outputCost: 10 });
            expect(source).toBe('local_cache');
            expect(generatedAt).toBe('2026-03-03');
        });

        it('merges an override on top and reports source "override"', async () => {
            mockExistsSync.mockReturnValue(false);

            const [pricing, source] = await loadPricingWithSource({
                'gpt-4': { inputCost: 999, outputCost: 999 },
            });

            expect(pricing['gpt-4']).toEqual({ inputCost: 999, outputCost: 999, _override: true });
            expect(source).toBe('override');
        });

        it('loadPricing returns just the pricing table', async () => {
            mockExistsSync.mockReturnValue(false);

            const pricing = await loadPricing();

            expect(pricing).toEqual(DEFAULT_PRICING);
        });
    });

    describe('snapshotAgeDays', () => {
        it('returns undefined for an empty/"unknown" generatedAt', () => {
            expect(snapshotAgeDays('')).toBeUndefined();
            expect(snapshotAgeDays('unknown')).toBeUndefined();
        });

        it('returns undefined for an unparseable date', () => {
            expect(snapshotAgeDays('not-a-date')).toBeUndefined();
        });

        it('returns the age in days for a valid ISO date', () => {
            const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();

            const age = snapshotAgeDays(twoDaysAgo);

            expect(age).toBeGreaterThan(1.9);
            expect(age).toBeLessThan(2.1);
        });

        it('returns undefined (swallows the error) when Date construction throws', () => {
            const originalDate = global.Date;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (global as any).Date = function () {
                throw new Error('boom');
            };
            global.Date.now = originalDate.now;

            expect(snapshotAgeDays('2026-01-01T00:00:00Z')).toBeUndefined();

            global.Date = originalDate;
        });
    });

    describe('fetchRemotePricing', () => {
        it('resolves with DEFAULT_PRICING', async () => {
            await expect(fetchRemotePricing()).resolves.toEqual(DEFAULT_PRICING);
        });
    });
});
