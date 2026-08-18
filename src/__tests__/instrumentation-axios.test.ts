import { patchAxios, createTracedAxios } from '../instrumentation/axios';
import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

jest.mock('../auto', () => ({
    getTracer: jest.fn()
}));

describe('Axios Instrumentation', () => {
    let mockSpan: ISpan;
    let mockTracer: any;
    let mockAxios: any;

    beforeEach(() => {
        jest.resetModules();
        mockSpan = {
            setAttribute: jest.fn(),
            end: jest.fn(),
            recordException: jest.fn(),
        } as unknown as ISpan;

        mockTracer = {
            startActiveSpan: jest.fn((name, fn) => fn(mockSpan))
        };

        (getTracer as jest.Mock).mockReturnValue(mockTracer);

        mockAxios = {
            interceptors: {
                request: { use: jest.fn() },
                response: { use: jest.fn() }
            },
            create: jest.fn().mockReturnValue({
                interceptors: {
                    request: { use: jest.fn() },
                    response: { use: jest.fn() }
                }
            })
        };
        
        jest.clearAllMocks();
    });

    describe('patchAxios', () => {
        it('should patch axios and attach interceptors', () => {
            jest.doMock('axios', () => mockAxios, { virtual: true });

            const result = patchAxios();
            expect(result).toBe(true);
            expect(mockAxios.interceptors.request.use).toHaveBeenCalled();
            expect(mockAxios.interceptors.response.use).toHaveBeenCalled();
        });

        // `_patched` is module-level state, so every other patchAxios branch
        // needs a fresh module instance via jest.isolateModules (same pattern
        // already applied to gemini.ts/openai.ts/anthropic.ts).
        it('returns false when axios is not installed', () => {
            jest.isolateModules(() => {
                jest.doMock('axios', () => {
                    throw new Error('Cannot find module \'axios\'');
                }, { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/axios');
                expect(() => fresh.patchAxios()).not.toThrow();
                expect(fresh.patchAxios()).toBe(false);

                jest.dontMock('axios');
            });
        });

        it('returns false when axios resolves to a falsy module', () => {
            jest.isolateModules(() => {
                jest.doMock('axios', () => null, { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/axios');
                expect(fresh.patchAxios()).toBe(false);

                jest.dontMock('axios');
            });
        });

        it('uses axios.default when present (ESM-style module)', () => {
            jest.isolateModules(() => {
                const esmAxios = { default: mockAxios };
                jest.doMock('axios', () => esmAxios, { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/axios');
                expect(fresh.patchAxios()).toBe(true);
                expect(mockAxios.interceptors.request.use).toHaveBeenCalled();

                jest.dontMock('axios');
            });
        });

        it('returns true on subsequent calls without re-checking the module', () => {
            jest.isolateModules(() => {
                jest.doMock('axios', () => mockAxios, { virtual: true });

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/axios');
                expect(fresh.patchAxios()).toBe(true);

                jest.dontMock('axios');
                jest.doMock('axios', () => {
                    throw new Error('should never be reached');
                }, { virtual: true });
                expect(fresh.patchAxios()).toBe(true);

                jest.dontMock('axios');
            });
        });

        describe('patched interceptor callbacks', () => {
            function patchWithFreshAxios() {
                let capturedFresh: any;
                jest.isolateModules(() => {
                    jest.doMock('axios', () => mockAxios, { virtual: true });
                    // isolateModules gives the freshly required axios.ts its own
                    // '../auto' automock instance too, so getTracer must be
                    // reconfigured inside the isolated registry - the outer
                    // `getTracer` reference from the top-level import is a
                    // different mock instance and won't affect this one.
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const freshAuto = require('../auto');
                    freshAuto.getTracer.mockReturnValue(mockTracer);

                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    capturedFresh = require('../instrumentation/axios');
                    capturedFresh.patchAxios();
                    jest.dontMock('axios');
                });
                return capturedFresh;
            }

            it('skips tracing for Traccia platform bookkeeping/OTLP URLs', () => {
                patchWithFreshAxios();
                const responseInterceptor = mockAxios.interceptors.response.use.mock.calls[0][0];

                for (const url of [
                    'https://api.traccia.ai/api/v1/eval-runtime/score',
                    'https://api.traccia.ai/v2/traces',
                    'https://api.traccia.ai/v1/traces',
                    'https://api.traccia.ai/v2/metrics',
                    'https://api.traccia.ai/v1/metrics',
                ]) {
                    const response = { status: 200, config: { method: 'post', url } };
                    const result = responseInterceptor(response);
                    expect(result).toBe(response);
                }

                expect(mockTracer.startActiveSpan).not.toHaveBeenCalled();
            });

            it('traces a normal (non-platform) response, including duration when a start time was captured', () => {
                patchWithFreshAxios();
                const responseInterceptor = mockAxios.interceptors.response.use.mock.calls[0][0];

                const response = {
                    status: 200,
                    config: {
                        method: 'get',
                        url: 'https://example.com/api',
                        baseURL: undefined,
                        _tracciaStartTime: Date.now() - 50,
                    },
                };
                const result = responseInterceptor(response);

                expect(result).toBe(response);
                expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('http.GET', expect.any(Function));
                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.host', 'example.com');
                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.path', '/api');
                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.duration_ms', expect.any(Number));
            });

            it('resolves a relative url against config.baseURL', () => {
                patchWithFreshAxios();
                const responseInterceptor = mockAxios.interceptors.response.use.mock.calls[0][0];

                const response = {
                    status: 200,
                    config: { method: 'get', url: '/users/1', baseURL: 'https://api.example.com' },
                };
                responseInterceptor(response);

                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.host', 'api.example.com');
                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.path', '/users/1');
            });

            it('silently skips host/path attributes when the URL cannot be parsed', () => {
                patchWithFreshAxios();
                const responseInterceptor = mockAxios.interceptors.response.use.mock.calls[0][0];

                const response = {
                    status: 200,
                    config: { method: 'get', url: 'not a valid url', baseURL: undefined },
                };
                expect(() => responseInterceptor(response)).not.toThrow();

                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('http.host', expect.anything());
            });

            it('omits url/status/duration attributes when those fields are missing', () => {
                patchWithFreshAxios();
                const responseInterceptor = mockAxios.interceptors.response.use.mock.calls[0][0];

                const response = { config: { method: 'get' } };
                responseInterceptor(response);

                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('http.url', expect.anything());
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('http.status_code', expect.anything());
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('http.duration_ms', expect.anything());
            });

            it('the request interceptor stores a start time on config', () => {
                patchWithFreshAxios();
                const requestInterceptor = mockAxios.interceptors.request.use.mock.calls[0][0];

                const config: Record<string, unknown> = {};
                const result = requestInterceptor(config);

                expect(result._tracciaStartTime).toBeDefined();
            });

            it('the request error interceptor rejects', async () => {
                patchWithFreshAxios();
                const requestErrorInterceptor = mockAxios.interceptors.request.use.mock.calls[0][1];

                await expect(requestErrorInterceptor(new Error('req err'))).rejects.toThrow('req err');
            });

            it('traces and records an error response, omitting url/status when absent', async () => {
                patchWithFreshAxios();
                const errorInterceptor = mockAxios.interceptors.response.use.mock.calls[0][1];

                const error = new Error('boom') as any;
                error.config = {};

                await expect(errorInterceptor(error)).rejects.toThrow('boom');

                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('http.url', expect.anything());
                expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('http.status_code', expect.anything());
                expect(mockSpan.recordException).toHaveBeenCalledWith(error);
                expect(mockSpan.status).toBe(SpanStatus.ERROR);
            });

            it('includes url/status attributes on an error response when present', async () => {
                patchWithFreshAxios();
                const errorInterceptor = mockAxios.interceptors.response.use.mock.calls[0][1];

                const error = new Error('Not found') as any;
                error.config = { method: 'get', url: 'https://example.com/api' };
                error.response = { status: 404 };

                await expect(errorInterceptor(error)).rejects.toThrow('Not found');

                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', 'https://example.com/api');
                expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.status_code', 404);
            });
        });
    });

    describe('createTracedAxios error handling', () => {
        it('returns null and logs when require(axios) throws', () => {
            jest.isolateModules(() => {
                jest.doMock('axios', () => {
                    throw new Error('Cannot find module \'axios\'');
                }, { virtual: true });
                const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fresh = require('../instrumentation/axios');
                const result = fresh.createTracedAxios();

                expect(result).toBeNull();
                expect(errorSpy).toHaveBeenCalledWith('Axios patch error', expect.any(Error));

                errorSpy.mockRestore();
                jest.dontMock('axios');
            });
        });
    });

    describe('Interceptors functionality via createTracedAxios', () => {
        it('creates a traced axios instance', () => {
            jest.doMock('axios', () => mockAxios, { virtual: true });
            const instance = createTracedAxios() as any;
            expect(instance).toBeDefined();
            expect(instance.interceptors).toBeDefined();
            expect(mockAxios.create).toHaveBeenCalled();
        });

        it('request interceptor adds start time', () => {
            jest.doMock('axios', () => mockAxios, { virtual: true });
            const instance = createTracedAxios() as any;
            
            const requestInterceptor = instance.interceptors.request.use.mock.calls[0][0];
            const config = { url: 'test' };
            const result = requestInterceptor(config);
            
            expect(result._tracciaStartTime).toBeDefined();
        });

        it('request error interceptor rejects', async () => {
            jest.doMock('axios', () => mockAxios, { virtual: true });
            const instance = createTracedAxios() as any;
            
            const requestErrorInterceptor = instance.interceptors.request.use.mock.calls[0][1];
            await expect(requestErrorInterceptor(new Error('req err'))).rejects.toThrow('req err');
        });

        it('response interceptor creates span for success', () => {
            jest.doMock('axios', () => mockAxios, { virtual: true });
            const instance = createTracedAxios() as any;
            const responseInterceptor = instance.interceptors.response.use.mock.calls[0][0];
            
            const response = {
                status: 200,
                config: {
                    method: 'post',
                    url: 'https://example.com/api',
                    _tracciaStartTime: Date.now() - 100
                }
            };

            const result = responseInterceptor(response);
            expect(result).toBe(response);

            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('http.POST', expect.any(Function));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('span.type', 'TOOL');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', 'https://example.com/api');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.duration_ms', expect.any(Number));
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('response interceptor creates span for error', async () => {
            jest.doMock('axios', () => mockAxios, { virtual: true });
            const instance = createTracedAxios() as any;
            const errorInterceptor = instance.interceptors.response.use.mock.calls[0][1];
            
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
