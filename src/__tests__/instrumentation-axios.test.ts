import axios from 'axios';
import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

jest.mock('../auto', () => ({
    getTracer: jest.fn(),
}));

/**
 * axios is a hard dependency. Mock it (non-virtual) so publish CI cannot
 * load the real module and patch Axios.prototype.request globally.
 */
jest.mock('axios', () => {
    class Axios {
        defaults = { baseURL: '' };
    }
    (Axios.prototype as unknown as { request: jest.Mock }).request = jest
        .fn()
        .mockResolvedValue({ status: 200 });
    const interceptors = {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
    };
    const lib = {
        Axios,
        interceptors,
        create: jest.fn(),
    };
    return {
        __esModule: true,
        default: lib,
        ...lib,
    };
});

const mockedAxios = axios as jest.Mocked<typeof axios> & {
    Axios: { prototype: { request: jest.Mock } };
    interceptors: {
        request: { use: jest.Mock };
        response: { use: jest.Mock };
    };
    create: jest.Mock;
};

describe('Axios Instrumentation', () => {
    let mockSpan: ISpan;
    let mockTracer: { startActiveSpan: jest.Mock };
    let originalProtoRequest: jest.Mock;

    beforeEach(() => {
        mockSpan = {
            setAttribute: jest.fn(),
            end: jest.fn(),
            recordException: jest.fn(),
        } as unknown as ISpan;

        mockTracer = {
            startActiveSpan: jest.fn((name: string, fn: (span: ISpan) => unknown) => fn(mockSpan)),
        };
        (getTracer as jest.Mock).mockReturnValue(mockTracer);

        originalProtoRequest = mockedAxios.Axios.prototype.request;
        jest.clearAllMocks();
        originalProtoRequest.mockReset();
        originalProtoRequest.mockResolvedValue({ status: 200 });
        (getTracer as jest.Mock).mockReturnValue(mockTracer);
    });

    afterEach(() => {
        mockedAxios.Axios.prototype.request = originalProtoRequest;
    });

    function loadFresh() {
        let fresh: {
            patchAxios: () => boolean;
            createTracedAxios: () => unknown;
        };
        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const freshAuto = require('../auto');
            freshAuto.getTracer.mockReturnValue(mockTracer);
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            fresh = require('../instrumentation/axios');
        });
        return fresh!;
    }

    describe('patchAxios', () => {
        it('wraps Axios.prototype.request when the class is present', async () => {
            const fresh = loadFresh();
            expect(fresh.patchAxios()).toBe(true);
            expect(mockedAxios.interceptors.request.use).not.toHaveBeenCalled();

            await mockedAxios.Axios.prototype.request({
                method: 'get',
                url: 'https://example.com/api',
            });

            expect(originalProtoRequest).toHaveBeenCalled();
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('http.client', expect.any(Function));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.method', 'GET');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', 'https://example.com/api');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.host', 'example.com');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.path', '/api');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
        });

        it('skips tracing for Traccia ingest, eval, and prompt-runtime URLs', async () => {
            const fresh = loadFresh();
            fresh.patchAxios();

            for (const url of [
                'https://api.traccia.ai/api/v1/eval-runtime/score',
                'https://api.traccia.ai/v2/traces',
                'https://api.traccia.ai/v1/traces',
                'https://api.traccia.ai/v2/metrics',
                'https://api.traccia.ai/v1/metrics',
                'http://localhost:8001/api/v1/prompt-runtime/prompts/support-reply',
            ]) {
                await mockedAxios.Axios.prototype.request({ method: 'get', url });
            }

            expect(originalProtoRequest).toHaveBeenCalledTimes(6);
            expect(mockTracer.startActiveSpan).not.toHaveBeenCalled();
        });

        it('resolves a relative url against instance defaults', async () => {
            const fresh = loadFresh();
            fresh.patchAxios();

            await mockedAxios.Axios.prototype.request.call(
                { defaults: { baseURL: 'https://api.example.com' } },
                { method: 'get', url: '/users/1' },
            );

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', 'https://api.example.com/users/1');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.host', 'api.example.com');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.path', '/users/1');
        });

        it('records errors from the underlying request', async () => {
            const err = Object.assign(new Error('Not found'), { response: { status: 404 } });
            originalProtoRequest.mockRejectedValue(err);
            const fresh = loadFresh();
            fresh.patchAxios();

            await expect(
                mockedAxios.Axios.prototype.request({ url: 'https://example.com/api' }),
            ).rejects.toThrow('Not found');

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.status_code', 404);
            expect(mockSpan.recordException).toHaveBeenCalledWith(err);
            expect(mockSpan.status).toBe(SpanStatus.ERROR);
        });

        it('falls back to default-instance interceptors when Axios.prototype.request is missing', () => {
            delete (mockedAxios.Axios.prototype as { request?: jest.Mock }).request;
            const fresh = loadFresh();
            expect(fresh.patchAxios()).toBe(true);
            expect(mockedAxios.interceptors.request.use).toHaveBeenCalled();
            expect(mockedAxios.interceptors.response.use).toHaveBeenCalled();
        });

        it('returns false when axios has neither a prototype request nor interceptors', () => {
            delete (mockedAxios.Axios.prototype as { request?: jest.Mock }).request;
            const saved = mockedAxios.interceptors;
            (mockedAxios as { interceptors?: unknown }).interceptors = undefined;
            (mockedAxios as { default?: unknown }).default = mockedAxios;

            const fresh = loadFresh();
            expect(fresh.patchAxios()).toBe(false);

            mockedAxios.interceptors = saved;
        });

        it('uses axios.default when present (ESM-style module)', async () => {
            const fresh = loadFresh();
            expect(fresh.patchAxios()).toBe(true);

            await mockedAxios.Axios.prototype.request({ url: 'https://example.com/api' });
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('http.client', expect.any(Function));
        });

        it('returns true on subsequent calls without re-checking the module', () => {
            const fresh = loadFresh();
            expect(fresh.patchAxios()).toBe(true);
            expect(fresh.patchAxios()).toBe(true);
        });

        describe('interceptor fallback callbacks', () => {
            function patchWithInterceptors() {
                delete (mockedAxios.Axios.prototype as { request?: jest.Mock }).request;
                const fresh = loadFresh();
                fresh.patchAxios();
                return mockedAxios.interceptors;
            }

            it('skips tracing for Traccia platform bookkeeping/OTLP URLs', () => {
                const interceptors = patchWithInterceptors();
                const responseInterceptor = interceptors.response.use.mock.calls[0][0];

                for (const url of [
                    'https://api.traccia.ai/api/v1/eval-runtime/score',
                    'https://api.traccia.ai/v2/traces',
                    'https://api.traccia.ai/v1/traces',
                    'https://api.traccia.ai/v2/metrics',
                    'https://api.traccia.ai/v1/metrics',
                ]) {
                    const response = { status: 200, config: { method: 'post', url } };
                    expect(responseInterceptor(response)).toBe(response);
                }

                expect(mockTracer.startActiveSpan).not.toHaveBeenCalled();
            });

            it('traces a normal (non-platform) response, including duration when a start time was captured', () => {
                const interceptors = patchWithInterceptors();
                const responseInterceptor = interceptors.response.use.mock.calls[0][0];

                const response = {
                    status: 200,
                    config: {
                        method: 'get',
                        url: 'https://example.com/api',
                        _tracciaStartTime: Date.now() - 50,
                    },
                };
                expect(responseInterceptor(response)).toBe(response);
                expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('http.GET', expect.any(Function));
                expect(mockSpan.setAttribute).toHaveBeenCalledWith('span.type', 'TOOL');
                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.host', 'example.com');
                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.path', '/api');
                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.duration_ms', expect.any(Number));
            });

            it('resolves a relative url against config.baseURL', () => {
                const interceptors = patchWithInterceptors();
                const responseInterceptor = interceptors.response.use.mock.calls[0][0];

                responseInterceptor({
                    status: 200,
                    config: { method: 'get', url: '/users/1', baseURL: 'https://api.example.com' },
                });

                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.host', 'api.example.com');
                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.path', '/users/1');
            });

            it('silently skips host/path attributes when the URL cannot be parsed', () => {
                const interceptors = patchWithInterceptors();
                const responseInterceptor = interceptors.response.use.mock.calls[0][0];

                expect(() =>
                    responseInterceptor({
                        status: 200,
                        config: { method: 'get', url: 'not a valid url', baseURL: undefined },
                    }),
                ).not.toThrow();

                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('http.host', expect.anything());
            });

            it('omits url/status/duration attributes when those fields are missing', () => {
                const interceptors = patchWithInterceptors();
                const responseInterceptor = interceptors.response.use.mock.calls[0][0];

                responseInterceptor({ config: { method: 'get' } });

                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('http.url', expect.anything());
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('http.status_code', expect.anything());
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('http.duration_ms', expect.anything());
            });

            it('the request interceptor stores a start time on config', () => {
                const interceptors = patchWithInterceptors();
                const requestInterceptor = interceptors.request.use.mock.calls[0][0];
                const config: Record<string, unknown> = {};
                expect(requestInterceptor(config)._tracciaStartTime).toBeDefined();
            });

            it('the request error interceptor rejects', async () => {
                const interceptors = patchWithInterceptors();
                const requestErrorInterceptor = interceptors.request.use.mock.calls[0][1];
                await expect(requestErrorInterceptor(new Error('req err'))).rejects.toThrow('req err');
            });

            it('traces and records an error response, omitting url/status when absent', async () => {
                const interceptors = patchWithInterceptors();
                const errorInterceptor = interceptors.response.use.mock.calls[0][1];
                const error = new Error('boom') as any;
                error.config = {};

                await expect(errorInterceptor(error)).rejects.toThrow('boom');
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('http.url', expect.anything());
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('http.status_code', expect.anything());
                expect(mockSpan.recordException).toHaveBeenCalledWith(error);
                expect(mockSpan.status).toBe(SpanStatus.ERROR);
            });

            it('includes url/status attributes on an error response when present', async () => {
                const interceptors = patchWithInterceptors();
                const errorInterceptor = interceptors.response.use.mock.calls[0][1];
                const error = new Error('Not found') as any;
                error.config = { method: 'get', url: 'https://example.com/api' };
                error.response = { status: 404 };

                await expect(errorInterceptor(error)).rejects.toThrow('Not found');
                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', 'https://example.com/api');
                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.status_code', 404);
            });
        });
    });

    describe('createTracedAxios', () => {
        it('returns null and logs when axios.create throws', () => {
            mockedAxios.create.mockImplementation(() => {
                throw new Error('Cannot find module \'axios\'');
            });
            const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const fresh = loadFresh();
            expect(fresh.createTracedAxios()).toBeNull();
            expect(errorSpy).toHaveBeenCalledWith('Axios patch error', expect.any(Error));
            errorSpy.mockRestore();
        });

        it('creates a traced axios instance', () => {
            const created = {
                interceptors: {
                    request: { use: jest.fn() },
                    response: { use: jest.fn() },
                },
            };
            mockedAxios.create.mockReturnValue(created);
            const fresh = loadFresh();
            expect(fresh.createTracedAxios()).toBe(created);
            expect(mockedAxios.create).toHaveBeenCalled();
            expect(created.interceptors.request.use).toHaveBeenCalled();
        });

        it('request interceptor adds start time', () => {
            const created = {
                interceptors: {
                    request: { use: jest.fn() },
                    response: { use: jest.fn() },
                },
            };
            mockedAxios.create.mockReturnValue(created);
            loadFresh().createTracedAxios();
            const requestInterceptor = created.interceptors.request.use.mock.calls[0][0];
            expect(requestInterceptor({ url: 'test' })._tracciaStartTime).toBeDefined();
        });

        it('request error interceptor rejects', async () => {
            const created = {
                interceptors: {
                    request: { use: jest.fn() },
                    response: { use: jest.fn() },
                },
            };
            mockedAxios.create.mockReturnValue(created);
            loadFresh().createTracedAxios();
            const requestErrorInterceptor = created.interceptors.request.use.mock.calls[0][1];
            await expect(requestErrorInterceptor(new Error('req err'))).rejects.toThrow('req err');
        });

        it('response interceptor creates span for success', () => {
            const created = {
                interceptors: {
                    request: { use: jest.fn() },
                    response: { use: jest.fn() },
                },
            };
            mockedAxios.create.mockReturnValue(created);
            loadFresh().createTracedAxios();
            const responseInterceptor = created.interceptors.response.use.mock.calls[0][0];

            const response = {
                status: 200,
                config: {
                    method: 'post',
                    url: 'https://example.com/api',
                    _tracciaStartTime: Date.now() - 100,
                },
            };
            expect(responseInterceptor(response)).toBe(response);
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('http.POST', expect.any(Function));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('span.type', 'TOOL');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', 'https://example.com/api');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.duration_ms', expect.any(Number));
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('response interceptor creates span for error', async () => {
            const created = {
                interceptors: {
                    request: { use: jest.fn() },
                    response: { use: jest.fn() },
                },
            };
            mockedAxios.create.mockReturnValue(created);
            loadFresh().createTracedAxios();
            const errorInterceptor = created.interceptors.response.use.mock.calls[0][1];

            const error = new Error('Not found') as any;
            error.config = { method: 'get', url: 'https://example.com/api' };
            error.response = { status: 404 };

            await expect(errorInterceptor(error)).rejects.toThrow('Not found');
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('http.GET', expect.any(Function));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('span.type', 'TOOL');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', 'https://example.com/api');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.status_code', 404);
            expect(mockSpan.recordException).toHaveBeenCalledWith(error);
            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.end).toHaveBeenCalled();
        });
    });
});
