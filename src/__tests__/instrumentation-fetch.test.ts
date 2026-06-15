import { patchFetch, unpatchFetch, createTracedFetch } from '../instrumentation/fetch';
import * as auto from '../auto';
import { SpanStatus } from '../types';

describe('Fetch Instrumentation', () => {
    let originalFetch: any;
    let mockTracer: any;
    let mockSpan: any;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        mockSpan = {
            setAttribute: jest.fn(),
            recordException: jest.fn(),
            end: jest.fn(),
            status: SpanStatus.OK,
            statusDescription: '',
        };
        mockTracer = {
            startActiveSpan: jest.fn((name, callback) => callback(mockSpan)),
        };
        jest.spyOn(auto, 'getTracer').mockReturnValue(mockTracer);
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        unpatchFetch();
        jest.restoreAllMocks();
    });

    describe('patchFetch', () => {
        it('should return false if globalThis.fetch is not a function', () => {
            const temp = globalThis.fetch;
            delete (globalThis as any).fetch;
            const patched = patchFetch();
            expect(patched).toBe(false);
            globalThis.fetch = temp;
        });

        it('should patch fetch and trace successful requests (string input)', async () => {
            globalThis.fetch = jest.fn().mockResolvedValue({ status: 200, statusText: 'OK' });
            
            expect(patchFetch()).toBe(true);
            expect(patchFetch()).toBe(true); // Should return true immediately if already patched

            const response = await globalThis.fetch('https://example.com/api', { method: 'POST' });
            
            expect(response.status).toBe(200);
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('http.POST', expect.any(Function));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', 'https://example.com/api');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.host', 'example.com');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.path', '/api');
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('should handle URL object input', async () => {
            globalThis.fetch = jest.fn().mockResolvedValue({ status: 200, statusText: 'OK' });
            patchFetch();

            await (globalThis.fetch as any)({ url: 'https://test.com', method: 'PUT' });
            
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('http.PUT', expect.any(Function));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', 'https://test.com');
        });

        it('should handle stringable object input', async () => {
            globalThis.fetch = jest.fn().mockResolvedValue({ status: 200, statusText: 'OK' });
            patchFetch();

            const input = { toString: () => 'https://string.com' };
            await globalThis.fetch(input as any);
            
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('http.GET', expect.any(Function));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', 'https://string.com');
        });

        it('should trace failed requests and set status ERROR', async () => {
            globalThis.fetch = jest.fn().mockResolvedValue({ status: 404, statusText: 'Not Found' });
            patchFetch();

            await globalThis.fetch('https://example.com');
            
            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.statusDescription).toBe('HTTP 404 Not Found');
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('should trace exceptions', async () => {
            globalThis.fetch = jest.fn().mockRejectedValue(new Error('Network Error'));
            patchFetch();

            await expect(globalThis.fetch('https://example.com')).rejects.toThrow('Network Error');
            
            expect(mockSpan.recordException).toHaveBeenCalledWith(expect.any(Error));
            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.statusDescription).toBe('Network Error');
            expect(mockSpan.end).toHaveBeenCalled();
        });
        
        it('should handle URL parsing errors gracefully', async () => {
            globalThis.fetch = jest.fn().mockResolvedValue({ status: 200, statusText: 'OK' });
            patchFetch();

            await globalThis.fetch('invalid_url_that_throws_on_parse');
            
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', 'invalid_url_that_throws_on_parse');
            expect(mockSpan.end).toHaveBeenCalled();
        });
    });

    describe('createTracedFetch', () => {
        it('should return a traced fetch function without patching global fetch', async () => {
            const fakeOriginal = jest.fn().mockResolvedValue({ status: 200, statusText: 'OK' });
            globalThis.fetch = fakeOriginal;
            
            const traced = createTracedFetch();
            expect(globalThis.fetch).toBe(fakeOriginal); // Not patched

            const response = await traced('https://example.com', { method: 'DELETE' });
            
            expect(response.status).toBe(200);
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('http.DELETE', expect.any(Function));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', 'https://example.com');
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('should trace exceptions in createTracedFetch', async () => {
            globalThis.fetch = jest.fn().mockRejectedValue(new Error('Fetch Error'));
            const traced = createTracedFetch();

            await expect(traced({ url: 'https://example.com' } as any)).rejects.toThrow('Fetch Error');
            
            expect(mockSpan.recordException).toHaveBeenCalledWith(expect.any(Error));
            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.end).toHaveBeenCalled();
        });
        
        it('should mark >= 400 as error', async () => {
            globalThis.fetch = jest.fn().mockResolvedValue({ status: 500, statusText: 'Internal Error' });
            const traced = createTracedFetch();

            await traced({ toString: () => 'https://err.com' } as any);
            
            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.end).toHaveBeenCalled();
        });
    });
});
