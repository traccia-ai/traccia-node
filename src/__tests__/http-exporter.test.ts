import https from 'https';
import http from 'http';
import { HttpExporter } from '../exporter/http-exporter';
import { ISpan } from '../types';

describe('HttpExporter', () => {
  let exporter: HttpExporter;
  let httpsRequestSpy: jest.SpyInstance;
  let httpRequestSpy: jest.SpyInstance;

  beforeEach(() => {
    httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation(() => {
      return {
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        destroy: jest.fn()
      } as any;
    });

    httpRequestSpy = jest.spyOn(http, 'request').mockImplementation(() => {
      return {
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        destroy: jest.fn()
      } as any;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const createMockSpan = (): ISpan => ({
    name: 'test-span',
    context: { traceId: 'trace-1', spanId: 'span-1', traceFlags: 1 },
    startTimeNs: 1000,
    endTimeNs: 2000,
    attributes: {},
    events: [],
    status: 1 // OK
  } as unknown as ISpan);

  function mockResponse(spy: jest.SpyInstance, statusCode: number, error?: Error, timeout?: boolean) {
    spy.mockImplementation((options, callback) => {
      const mockRequest = {
        on: jest.fn((event, handler) => {
          if (event === 'error' && error) {
            setTimeout(() => handler(error), 10);
          }
          if (event === 'timeout' && timeout) {
            setTimeout(() => handler(), 10);
          }
        }),
        write: jest.fn(),
        end: jest.fn(() => {
          if (!error && !timeout && callback) {
            const mockRes = {
              statusCode,
              on: jest.fn((event, handler) => {
                if (event === 'end') setTimeout(handler, 10);
              })
            };
            setTimeout(() => callback(mockRes), 10);
          }
        }),
        destroy: jest.fn()
      };
      return mockRequest as any;
    });
  }

  it('should not send request if spans array is empty', async () => {
    exporter = new HttpExporter();
    const result = await exporter.export([]);
    expect(result).toBe(true);
    expect(httpsRequestSpy).not.toHaveBeenCalled();
    expect(httpRequestSpy).not.toHaveBeenCalled();
  });

  it('should use https for https endpoint', async () => {
    exporter = new HttpExporter({ endpoint: 'https://test/api', apiKey: 'key1' });
    mockResponse(httpsRequestSpy, 200);
    
    const result = await exporter.export([createMockSpan()]);
    
    expect(result).toBe(true);
    expect(httpsRequestSpy).toHaveBeenCalled();
    expect(httpRequestSpy).not.toHaveBeenCalled();
    
    const options = httpsRequestSpy.mock.calls[0][0];
    expect(options.headers['Authorization']).toBe('Bearer key1');
  });

  it('should use http for http endpoint', async () => {
    exporter = new HttpExporter({ endpoint: 'http://test/api' });
    mockResponse(httpRequestSpy, 200);
    
    const result = await exporter.export([createMockSpan()]);
    
    expect(result).toBe(true);
    expect(httpRequestSpy).toHaveBeenCalled();
    expect(httpsRequestSpy).not.toHaveBeenCalled();
  });

  it('should retry on transient status codes (503)', async () => {
    exporter = new HttpExporter({ endpoint: 'http://test/api', maxRetries: 3, backoffBase: 0.01, backoffJitter: 0 });
    
    // Fail once with 503, then succeed
    mockResponse(httpRequestSpy, 503);
    
    const exportPromise = exporter.export([createMockSpan()]);
    
    // After a short delay, change mock to success
    setTimeout(() => {
      mockResponse(httpRequestSpy, 200);
    }, 50);

    const result = await exportPromise;
    expect(result).toBe(true);
    expect(httpRequestSpy).toHaveBeenCalledTimes(2);
  });

  it('should not retry on non-transient status codes (400)', async () => {
    exporter = new HttpExporter({ endpoint: 'http://test/api', maxRetries: 3 });
    mockResponse(httpRequestSpy, 400);
    
    const result = await exporter.export([createMockSpan()]);
    expect(result).toBe(false);
    expect(httpRequestSpy).toHaveBeenCalledTimes(1);
  });

  it('should retry on network errors', async () => {
    exporter = new HttpExporter({ endpoint: 'http://test/api', maxRetries: 2, backoffBase: 0.01, backoffJitter: 0 });
    mockResponse(httpRequestSpy, 0, new Error('ECONNREFUSED'));
    
    const result = await exporter.export([createMockSpan()]);
    expect(result).toBe(false);
    expect(httpRequestSpy).toHaveBeenCalledTimes(2);
  });

  it('should retry on timeouts', async () => {
    exporter = new HttpExporter({ endpoint: 'http://test/api', maxRetries: 2, backoffBase: 0.01, backoffJitter: 0 });
    mockResponse(httpRequestSpy, 0, undefined, true);
    
    const result = await exporter.export([createMockSpan()]);
    expect(result).toBe(false);
    expect(httpRequestSpy).toHaveBeenCalledTimes(2);
  });

  it('should parse otel status', async () => {
    exporter = new HttpExporter({ endpoint: 'http://test/api' });
    mockResponse(httpRequestSpy, 200);
    
    const span = createMockSpan();
    (span.status as any) = { code: 2, message: 'error' }; // valid otel status
    
    await exporter.export([span]);
    
    const payload = JSON.parse(httpRequestSpy.mock.results[0].value.write.mock.calls[0][0]);
    const otelSpan = payload.items[0].scopeSpans[0].spans[0];
    expect(otelSpan.status).toEqual({ code: 2, message: 'error' });
  });

  it('should serialize custom status to otel status', async () => {
    exporter = new HttpExporter({ endpoint: 'http://test/api' });
    mockResponse(httpRequestSpy, 200);
    
    const span = createMockSpan();
    span.status = 1; // custom status
    span.statusDescription = 'success';
    
    await exporter.export([span]);
    
    const payload = JSON.parse(httpRequestSpy.mock.results[0].value.write.mock.calls[0][0]);
    const otelSpan = payload.items[0].scopeSpans[0].spans[0];
    expect(otelSpan.status).toEqual({ code: 'OK', message: 'success' });
  });

  it('should have a noop shutdown method', async () => {
    exporter = new HttpExporter();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });
});
