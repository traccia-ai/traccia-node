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
