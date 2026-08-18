jest.mock('axios');
jest.mock('../prompts/client', () => ({
    resolveCredentials: jest.fn(),
    fetchPromptRuntime: jest.fn(),
}));

import axios from 'axios';
import {
    fetchDataset,
    fetchDatasetItems,
    createEphemeralDataset,
    fetchScorer,
    scoreRemote,
    createExperiment,
    resolvePromptVersionIds,
} from '../eval/client';
import { EvaluateError } from '../eval/errors';
import { resolveCredentials, fetchPromptRuntime } from '../prompts/client';

describe('eval/client', () => {
    const mockAxiosRequest = axios.request as jest.Mock;
    const mockResolveCredentials = resolveCredentials as jest.Mock;
    const mockFetchPromptRuntime = fetchPromptRuntime as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockResolveCredentials.mockReturnValue({ apiKey: 'test-key', baseUrl: 'https://api.example.com' });
    });

    describe('request() (via fetchDataset)', () => {
        it('resolves with resp.data on a 2xx response', async () => {
            mockAxiosRequest.mockResolvedValue({ status: 200, data: { id: 'ds-1' } });

            const result = await fetchDataset('my-dataset');

            expect(result).toEqual({ id: 'ds-1' });
            expect(mockAxiosRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'GET',
                    url: 'https://api.example.com/api/v1/eval-runtime/datasets/my-dataset',
                    headers: {
                        Authorization: 'Bearer test-key',
                        'Content-Type': 'application/json',
                    },
                    timeout: 60000,
                    validateStatus: expect.any(Function),
                }),
            );
        });

        it('URL-encodes the dataset name/id', async () => {
            mockAxiosRequest.mockResolvedValue({ status: 200, data: {} });

            await fetchDataset('my dataset/with slash');

            expect(mockAxiosRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: 'https://api.example.com/api/v1/eval-runtime/datasets/my%20dataset%2Fwith%20slash',
                }),
            );
        });

        it('passes an apiKey override through to resolveCredentials', async () => {
            mockAxiosRequest.mockResolvedValue({ status: 200, data: {} });

            await fetchDataset('ds', { apiKey: 'override-key' } as any);

            expect(mockResolveCredentials).toHaveBeenCalledWith({
                apiKey: 'override-key',
                promptApiBase: undefined,
            });
        });

        it('throws EvaluateError using resp.data.detail when status >= 400', async () => {
            mockAxiosRequest.mockResolvedValue({
                status: 404,
                statusText: 'Not Found',
                data: { detail: 'dataset not found' },
            });

            await expect(fetchDataset('missing')).rejects.toThrow(
                new EvaluateError('Eval runtime 404: "dataset not found"'),
            );
        });

        it('falls back to resp.statusText when resp.data.detail is missing', async () => {
            mockAxiosRequest.mockResolvedValue({
                status: 500,
                statusText: 'Internal Server Error',
                data: {},
            });

            await expect(fetchDataset('x')).rejects.toThrow(
                new EvaluateError('Eval runtime 500: "Internal Server Error"'),
            );
        });

        it('wraps a network-level throw (e.g. axios rejecting) in EvaluateError', async () => {
            mockAxiosRequest.mockRejectedValue(new Error('ECONNREFUSED'));

            await expect(fetchDataset('x')).rejects.toThrow(
                new EvaluateError('Eval runtime request failed: ECONNREFUSED'),
            );
        });

        it('does not double-wrap an EvaluateError thrown from the status check', async () => {
            mockAxiosRequest.mockResolvedValue({
                status: 400,
                statusText: 'Bad Request',
                data: { detail: 'bad input' },
            });

            try {
                await fetchDataset('x');
                fail('expected fetchDataset to throw');
            } catch (err) {
                expect(err).toBeInstanceOf(EvaluateError);
                expect((err as EvaluateError).message).toBe('Eval runtime 400: "bad input"');
            }
        });
    });

    describe('fetchDatasetItems', () => {
        it('returns data.items when present', async () => {
            mockAxiosRequest.mockResolvedValue({ status: 200, data: { items: [{ id: 1 }, { id: 2 }] } });

            const result = await fetchDatasetItems('ds-1');

            expect(result).toEqual([{ id: 1 }, { id: 2 }]);
        });

        it('falls back to an empty array when items is missing', async () => {
            mockAxiosRequest.mockResolvedValue({ status: 200, data: {} });

            const result = await fetchDatasetItems('ds-1');

            expect(result).toEqual([]);
        });
    });

    describe('createEphemeralDataset', () => {
        it('builds the request body from name/description/items', async () => {
            mockAxiosRequest.mockResolvedValue({ status: 200, data: { id: 'ds-2' } });

            const result = await createEphemeralDataset({
                name: 'ephemeral',
                description: 'desc',
                items: [{ a: 1 }],
            });

            expect(result).toEqual({ id: 'ds-2' });
            expect(mockAxiosRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'POST',
                    url: 'https://api.example.com/api/v1/eval-runtime/datasets',
                    data: { name: 'ephemeral', description: 'desc', items: [{ a: 1 }] },
                }),
            );
        });
    });

    describe('fetchScorer', () => {
        it('URL-encodes the scorer name/id', async () => {
            mockAxiosRequest.mockResolvedValue({ status: 200, data: {} });

            await fetchScorer('scorer with spaces');

            expect(mockAxiosRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: 'https://api.example.com/api/v1/eval-runtime/scorers/scorer%20with%20spaces',
                }),
            );
        });
    });

    describe('scoreRemote', () => {
        it('maps all fields into the request body, defaulting providerKeys to {}', async () => {
            mockAxiosRequest.mockResolvedValue({ status: 200, data: { passed: true } });

            const result = await scoreRemote({
                scorerId: 'scorer-1',
                output: 'out',
                expectedOutput: 'exp',
                input: 'in',
            });

            expect(result).toEqual({ passed: true });
            expect(mockAxiosRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'POST',
                    url: 'https://api.example.com/api/v1/eval-runtime/score',
                    data: {
                        scorer_id: 'scorer-1',
                        scorer_name: undefined,
                        output: 'out',
                        expected_output: 'exp',
                        input: 'in',
                        provider_keys: {},
                    },
                }),
            );
        });
    });

    describe('createExperiment', () => {
        it('omits body.id when experimentId is not provided, defaults arrays/objects', async () => {
            mockAxiosRequest.mockResolvedValue({ status: 200, data: { id: 'exp-1' } });

            await createExperiment({ datasetId: 'ds-1' });

            expect(mockAxiosRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.not.objectContaining({ id: expect.anything() }),
                }),
            );
            expect(mockAxiosRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: {
                        dataset_id: 'ds-1',
                        name: undefined,
                        prompt_version_ids: [],
                        scorer_ids: [],
                        results: {},
                        aggregates: {},
                    },
                }),
            );
        });

        it('sets body.id when experimentId is provided', async () => {
            mockAxiosRequest.mockResolvedValue({ status: 200, data: {} });

            await createExperiment({ datasetId: 'ds-1', experimentId: 'exp-existing' });

            expect(mockAxiosRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ id: 'exp-existing' }),
                }),
            );
        });
    });

    describe('resolvePromptVersionIds', () => {
        it('returns [version_id] when payload.version_id is present', async () => {
            mockFetchPromptRuntime.mockResolvedValue({ payload: { version_id: 'v-1', id: 'p-1' } });

            const result = await resolvePromptVersionIds('my-prompt');

            expect(result).toEqual(['v-1']);
        });

        it('falls back to payload.id when version_id is absent', async () => {
            mockFetchPromptRuntime.mockResolvedValue({ payload: { id: 'p-1' } });

            const result = await resolvePromptVersionIds('my-prompt');

            expect(result).toEqual(['p-1']);
        });

        it('returns [] when neither version_id nor id is present', async () => {
            mockFetchPromptRuntime.mockResolvedValue({ payload: {} });

            const result = await resolvePromptVersionIds('my-prompt');

            expect(result).toEqual([]);
        });
    });
});
