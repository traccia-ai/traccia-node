import { expressMiddleware, expressErrorMiddleware } from '../instrumentation/express';
import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

jest.mock('../auto', () => ({
    getTracer: jest.fn()
}));

describe('Express Instrumentation', () => {
    let mockSpan: ISpan;
    let mockTracer: any;
    let mockReq: any;
    let mockRes: any;
    let mockNext: jest.Mock;

    beforeEach(() => {
        mockSpan = {
            setAttribute: jest.fn(),
            end: jest.fn(),
            recordException: jest.fn(),
            endTimeNs: undefined
        } as unknown as ISpan;

        mockTracer = {
            startSpan: jest.fn(() => mockSpan)
        };

        (getTracer as jest.Mock).mockReturnValue(mockTracer);

        mockReq = {
            method: 'GET',
            url: '/test',
            path: '/test',
            headers: {
                'user-agent': 'test-agent'
            },
            query: { q: 'search' },
            params: { id: '123' },
            ip: '127.0.0.1'
        };

        mockRes = {
            statusCode: 200,
            on: jest.fn()
        };

        mockNext = jest.fn();
        jest.clearAllMocks();
    });

    describe('expressMiddleware', () => {
        it('should skip tracing for ignored paths', () => {
            const middleware = expressMiddleware({ ignorePaths: ['/test', /^\/ignore/] });
            middleware(mockReq, mockRes, mockNext);

            expect(getTracer).not.toHaveBeenCalled();
            expect(mockNext).toHaveBeenCalled();
        });

        it('should create a span and set basic attributes', () => {
            const middleware = expressMiddleware();
            middleware(mockReq, mockRes, mockNext);

            expect(getTracer).toHaveBeenCalledWith('express');
            expect(mockTracer.startSpan).toHaveBeenCalledWith('GET /test');
            
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('span.type', 'TOOL');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.method', 'GET');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', '/test');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.client_ip', '127.0.0.1');

            expect(mockReq._tracciaSpan).toBe(mockSpan);
            expect(mockReq._tracciaStartTime).toBeDefined();
            expect(mockNext).toHaveBeenCalled();
        });

        it('should include headers and query if configured', () => {
            const middleware = expressMiddleware({ includeHeaders: true, includeQuery: true });
            middleware(mockReq, mockRes, mockNext);

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.request.header.user-agent', 'test-agent');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.query', JSON.stringify({ q: 'search' }));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.params', JSON.stringify({ id: '123' }));
        });

        it('should end span on response finish', () => {
            const middleware = expressMiddleware();
            middleware(mockReq, mockRes, mockNext);

            const finishHandler = mockRes.on.mock.calls.find((call: any) => call[0] === 'finish')[1];
            expect(finishHandler).toBeDefined();

            finishHandler();

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.duration_ms', expect.any(Number));
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('should end span with error status on >= 400', () => {
            mockRes.statusCode = 404;
            const middleware = expressMiddleware();
            middleware(mockReq, mockRes, mockNext);

            const finishHandler = mockRes.on.mock.calls.find((call: any) => call[0] === 'finish')[1];
            finishHandler();

            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.statusDescription).toBe('HTTP 404');
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('should handle response close event', () => {
            const middleware = expressMiddleware();
            middleware(mockReq, mockRes, mockNext);

            const closeHandler = mockRes.on.mock.calls.find((call: any) => call[0] === 'close')[1];
            expect(closeHandler).toBeDefined();

            closeHandler();

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.client_closed', true);
            expect(mockSpan.end).toHaveBeenCalled();
        });
    });

    describe('expressErrorMiddleware', () => {
        it('should record exception if span exists', () => {
            const middleware = expressErrorMiddleware();
            mockReq._tracciaSpan = mockSpan;
            
            const error = new Error('Test Error');
            middleware(error, mockReq, mockRes, mockNext);

            expect(mockSpan.recordException).toHaveBeenCalledWith(error);
            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.statusDescription).toBe('Test Error');
            expect(mockNext).toHaveBeenCalledWith(error);
        });

        it('should just call next if span does not exist', () => {
            const middleware = expressErrorMiddleware();
            const error = new Error('Test Error');
            middleware(error, mockReq, mockRes, mockNext);

            expect(mockSpan.recordException).not.toHaveBeenCalled();
            expect(mockNext).toHaveBeenCalledWith(error);
        });
    });
});
