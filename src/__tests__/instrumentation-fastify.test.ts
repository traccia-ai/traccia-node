import { fastifyPlugin, fastifyPluginAsync } from '../instrumentation/fastify';
import { getTracer } from '../auto';
import { SpanStatus, ISpan } from '../types';

jest.mock('../auto', () => ({
    getTracer: jest.fn()
}));

describe('Fastify Instrumentation', () => {
    let mockSpan: ISpan;
    let mockTracer: any;
    let mockFastify: any;
    let hooks: Record<string, Function>;

    beforeEach(() => {
        mockSpan = {
            setAttribute: jest.fn(),
            end: jest.fn(),
            recordException: jest.fn()
        } as unknown as ISpan;

        mockTracer = {
            startSpan: jest.fn(() => mockSpan)
        };

        (getTracer as jest.Mock).mockReturnValue(mockTracer);

        hooks = {};
        mockFastify = {
            addHook: jest.fn((name, handler) => {
                hooks[name] = handler;
            })
        };

        jest.clearAllMocks();
    });

    describe('fastifyPlugin', () => {
        it('should register hooks', () => {
            const plugin = fastifyPlugin();
            plugin(mockFastify, {}, jest.fn());

            expect(mockFastify.addHook).toHaveBeenCalledWith('onRequest', expect.any(Function));
            expect(mockFastify.addHook).toHaveBeenCalledWith('onResponse', expect.any(Function));
            expect(mockFastify.addHook).toHaveBeenCalledWith('onError', expect.any(Function));
        });

        it('onRequest hook should skip ignored paths', () => {
            const plugin = fastifyPlugin({ ignorePaths: ['/ignore'] });
            plugin(mockFastify, {}, jest.fn());

            const req = { url: '/ignore?test=1' };
            const done = jest.fn();

            hooks['onRequest'](req, {}, done);

            expect(getTracer).not.toHaveBeenCalled();
            expect(done).toHaveBeenCalled();
        });

        it('onRequest hook should create span and set attributes', () => {
            const plugin = fastifyPlugin({ includeHeaders: true, includeQuery: true });
            plugin(mockFastify, {}, jest.fn());

            const req = {
                method: 'POST',
                url: '/api/test?q=1',
                routerPath: '/api/test',
                ip: '127.0.0.1',
                headers: { 'user-agent': 'test' },
                query: { q: '1' },
                params: { id: '123' },
            } as any;
            const done = jest.fn();

            hooks['onRequest'](req, {}, done);

            expect(getTracer).toHaveBeenCalledWith('fastify');
            expect(mockTracer.startSpan).toHaveBeenCalledWith('POST /api/test');
            
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('span.type', 'TOOL');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.method', 'POST');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.url', '/api/test?q=1');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.path', '/api/test');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.route', '/api/test');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.client_ip', '127.0.0.1');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.request.header.user-agent', 'test');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.query', JSON.stringify({ q: '1' }));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.params', JSON.stringify({ id: '123' }));

            expect(req._tracciaSpan).toBe(mockSpan);
            expect(req._tracciaStartTime).toBeDefined();
            expect(done).toHaveBeenCalled();
        });

        it('onResponse hook should end span with status code', () => {
            const plugin = fastifyPlugin();
            plugin(mockFastify, {}, jest.fn());

            const req = {
                _tracciaSpan: mockSpan,
                _tracciaStartTime: Date.now() - 100
            } as any;
            const reply = { statusCode: 200 };
            const done = jest.fn();

            hooks['onResponse'](req, reply, done);

            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.status_code', 200);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('http.duration_ms', expect.any(Number));
            expect(mockSpan.end).toHaveBeenCalled();
            expect(done).toHaveBeenCalled();
        });

        it('onResponse hook should set error status for >= 400', () => {
            const plugin = fastifyPlugin();
            plugin(mockFastify, {}, jest.fn());

            const req = { _tracciaSpan: mockSpan } as any;
            const reply = { statusCode: 500 };
            const done = jest.fn();

            hooks['onResponse'](req, reply, done);

            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.statusDescription).toBe('HTTP 500');
            expect(mockSpan.end).toHaveBeenCalled();
            expect(done).toHaveBeenCalled();
        });

        it('onError hook should record exception', () => {
            const plugin = fastifyPlugin();
            plugin(mockFastify, {}, jest.fn());

            const req = { _tracciaSpan: mockSpan } as any;
            const error = new Error('Test Error');
            const done = jest.fn();

            hooks['onError'](req, {}, error, done);

            expect(mockSpan.recordException).toHaveBeenCalledWith(error);
            expect(mockSpan.status).toBe(SpanStatus.ERROR);
            expect(mockSpan.statusDescription).toBe('Test Error');
            expect(done).toHaveBeenCalled();
        });
    });

    describe('fastifyPluginAsync', () => {
        it('should resolve when plugin registration is successful', async () => {
            mockFastify.addHook = jest.fn();
            await expect(fastifyPluginAsync(mockFastify)).resolves.toBeUndefined();
        });

        it('should reject when plugin registration fails', async () => {
            mockFastify.addHook = jest.fn(() => {
                throw new Error('Sync error');
            });
            await expect(fastifyPluginAsync(mockFastify)).rejects.toThrow('Sync error');
        });
    });
});
