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
    loadPricingWithSource,
    loadPricing,
    snapshotAgeDays,
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

    describe('getBundledGeneratedAt', () => {
        it('returns null when the bundled file does not exist', () => {
            mockExistsSync.mockReturnValue(false);

            expect(getBundledGeneratedAt()).toBeNull();
        });

        it('returns generated_at when present', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ generated_at: '2026-02-02' }));

            expect(getBundledGeneratedAt()).toBe('2026-02-02');
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
        it('converts per-token cost to per-1K and builds the models table', async () => {
            mockAxiosGet.mockResolvedValue({
                data: {
                    'gpt-4': { input_cost_per_token: 0.00003, output_cost_per_token: 0.00006 },
                    'no-pricing-model': { some_other_field: true },
                },
            });

            const result = await fetchUpstreamPricing();

            expect(result).not.toBeNull();
            expect(result!.models['gpt-4'].inputCost).toBeCloseTo(0.03);
            expect(result!.models['gpt-4'].outputCost).toBeCloseTo(0.06);
            expect(result!.models['no-pricing-model']).toBeUndefined();
            expect(typeof result!.generated_at).toBe('string');
        });

        it('defaults inputCost/outputCost to 0 when only one of input/output cost is present', async () => {
            mockAxiosGet.mockResolvedValue({
                data: {
                    'input-only': { input_cost_per_token: 0.00001 },
                },
            });

            const result = await fetchUpstreamPricing();

            expect(result!.models['input-only']).toEqual({ inputCost: 0.01, outputCost: 0 });
        });

        it('treats a zero-valued cost-per-token as falsy, defaulting that side to 0', async () => {
            mockAxiosGet.mockResolvedValue({
                data: {
                    'free-model': { input_cost_per_token: 0, output_cost_per_token: 0.00002 },
                },
            });

            const result = await fetchUpstreamPricing();

            expect(result!.models['free-model']).toEqual({ inputCost: 0, outputCost: 0.02 });
        });

        it('skips non-object entries in the raw response', async () => {
            mockAxiosGet.mockResolvedValue({
                data: { sample_spec: 'a string, not an object' },
            });

            const result = await fetchUpstreamPricing();

            expect(result!.models).toEqual({});
        });

        it('returns null when the request fails', async () => {
            mockAxiosGet.mockRejectedValue(new Error('network error'));

            expect(await fetchUpstreamPricing()).toBeNull();
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
                data: { models: {}, generated_at: '2026-01-01' },
                headers: { ETag: '"abc123"' },
            });

            const result = await fetchPlatformPricing();

            expect(result!.etag).toBe('abc123');
        });

        it('defaults models to {} and generated_at to now when the response omits them', async () => {
            mockAxiosGet.mockResolvedValue({ status: 200, data: {}, headers: {} });

            const result = await fetchPlatformPricing();

            expect(result!.models).toEqual({});
            expect(typeof result!.generated_at).toBe('string');
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
        it('uses bundled pricing and source "bundled" when no local cache or override exist', async () => {
            mockExistsSync.mockReturnValue(false);

            const [pricing, source] = await loadPricingWithSource();

            expect(pricing).toEqual(DEFAULT_PRICING);
            expect(source).toBe('bundled');
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

            expect(pricing['gpt-4']).toEqual({ inputCost: 999, outputCost: 999 });
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
