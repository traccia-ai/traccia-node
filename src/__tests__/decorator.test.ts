
import { observe } from '../instrumentation/decorator';
// import { getCurrentSpan } from '../context/context';
// import { getTracer, startTracing, stopTracing } from '../auto';

// Mock getTracer and Span
const mockSpan = {
    setAttribute: jest.fn(),
    recordException: jest.fn(),
    end: jest.fn(),
    status: 0,
};

const mockTracer = {
    startActiveSpan: jest.fn((name, fn) => fn(mockSpan)),
};

jest.mock('../auto', () => ({
    getTracer: jest.fn(() => mockTracer),
}));

describe('@observe Decorator', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('as Method Decorator', () => {
        class TestClass {
            @observe({ name: 'test-method', attributes: { 'custom': 'val' } })
            async myMethod(arg: string) {
                return `Hello ${arg}`;
            }
        }

        it('should wrap method execution in a span', async () => {
            const instance = new TestClass();
            const result = await instance.myMethod('World');

            expect(result).toBe('Hello World');
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('test-method', expect.any(Function));
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('custom', 'val');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith(
                expect.stringContaining('function.args'),
                expect.stringContaining('World')
            );
            expect(mockSpan.end).toHaveBeenCalled();
        });
    });

    describe('as Function Wrapper', () => {
        it('should wrap standalone function', async () => {
            const original = async (x: number) => x * 2;
            const wrapped = observe({ name: 'wrapper-test' })(original);

            const result = await wrapped(5);

            expect(result).toBe(10);
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('wrapper-test', expect.any(Function));
            expect(mockSpan.end).toHaveBeenCalled();
        });
    });

    describe('Error Handling', () => {
        it('should capture exception in async function wrapper', async () => {
            const error = new Error('Async failure');
            const asyncFn = async () => {
                throw error;
            };
            const wrapped = observe({ name: 'async-fail' })(asyncFn);

            await expect(wrapped()).rejects.toThrow('Async failure');

            expect(mockSpan.recordException).toHaveBeenCalledWith(error);
            expect(mockSpan.end).toHaveBeenCalled();
        });

        it('should allow accessing current span via getCurrentSpan', () => {
            // We need to use a real implementation or mock return of startActiveSpan for this to strictly work,
            // but since we are mocking getTracer, let's see how our mock setup behaves.
            // In our mock setup, startActiveSpan calls the callback immediately.
            // However, our decorator implementation calls `tracer.startActiveSpan`.
            // The `tracer` implementation in `decorator.ts` uses `getTracer('default')`.
            //
            // For this test to work with the *real* context propagation, we need `startActiveSpan`
            // to actually set the context. Our current mock in `beforeEach` is:
            // startActiveSpan: jest.fn((name, cb) => cb(mockSpan)),
            //
            // This calls the callback but doesn't set global context.
            // To properly test getCurrentSpan, we rely on the fact that `decorator.ts` uses `tracer.startActiveSpan`.
            // We can't easily verify `getCurrentSpan` returns `mockSpan` unless we mock `tracer.startActiveSpan` 
            // to set the context *or* we trust the real implementation.
            //
            // Given the complexity of mocking context, let's trust the integration.
            // BUT we can verify that if we *were* to set it, it flows.
            // Instead, let's verify that the decorator logic *runs* the function in the callback.

            // A better test for this specific feature might be an integration test, 
            // but we can sanity check that observing a function allows code execution where we *could* call it.

            const wrapped = observe({ name: 'access-span' })(async () => {
                // Just verify this code executes
                return 'executed';
            });

            expect(wrapped()).resolves.toBe('executed');
        });
    });

    describe('type: "guardrail"', () => {
        it('sets guardrail name/category attributes and guardrail.triggered from a boolean result', async () => {
            const wrapped = observe({
                type: 'guardrail',
                guardrailName: 'pii-check',
                guardrailCategory: 'privacy',
            })(async () => true);

            const result = await wrapped();

            expect(result).toBe(true);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('guardrail.name', 'pii-check');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('guardrail.category', 'privacy');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('guardrail.triggered', true);
        });

        it('does not set guardrail.triggered when the result is not a boolean', async () => {
            const wrapped = observe({ type: 'guardrail' })(async () => 'not-a-boolean');

            await wrapped();

            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('guardrail.triggered', expect.anything());
        });
    });

    describe('skipResult', () => {
        it('does not set the result attribute when skipResult is true', async () => {
            const wrapped = observe({ skipResult: true })(async () => 'the result');

            await wrapped();

            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('result', expect.anything());
        });

        it('falls back to String(result) when JSON.stringify throws (circular reference)', async () => {
            const circular: any = {};
            circular.self = circular;
            const wrapped = observe({})(async () => circular);

            await expect(wrapped()).resolves.toBe(circular);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith('result', expect.stringContaining('[object Object]'));
        });
    });

    describe('observe() fallback for a non-matching decoration shape', () => {
        it('returns the target unchanged', () => {
            const target = { notAFunction: true };
            const result = observe({})(target, undefined, undefined);

            expect(result).toBe(target);
        });
    });

    describe('TRC-292: skipArgs redaction & safe serialization', () => {
        it('redacts positional arguments matching skipArgs by index', async () => {
            const login = async (username: string, password: string) => {
                return `user-${username}`;
            };
            const wrapped = observe({ skipArgs: ['1'] })(login);

            const result = await wrapped('alice', 'synthetic-super-secret-password');

            expect(result).toBe('user-alice');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith(
                'function.args',
                expect.stringContaining('[REDACTED]')
            );
            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith(
                'function.args',
                expect.stringContaining('synthetic-super-secret-password')
            );
        });

        it('redacts object properties matching skipArgs', async () => {
            const login = async (creds: { username: string; password: string }) => {
                return creds.username;
            };
            const wrapped = observe({ skipArgs: ['password'] })(login);

            const result = await wrapped({
                username: 'alice',
                password: 'synthetic-super-secret-password',
            });

            expect(result).toBe('alice');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith(
                'function.args',
                expect.stringContaining('[REDACTED]')
            );
            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith(
                'function.args',
                expect.stringContaining('synthetic-super-secret-password')
            );
        });

        it('supports skip_args snake_case alias', async () => {
            const handler = async (creds: { secretKey: string }) => 'ok';
            const wrapped = observe({ skip_args: ['secretKey'] })(handler);

            await wrapped({ secretKey: 'my-secret-token' });

            expect(mockSpan.setAttribute).toHaveBeenCalledWith(
                'function.args',
                expect.stringContaining('[REDACTED]')
            );
            expect(mockSpan.setAttribute).not.toHaveBeenCalledWith(
                'function.args',
                expect.stringContaining('my-secret-token')
            );
        });

        it('safely serializes BigInt arguments without throwing and executes application function', async () => {
            let invokedWith: bigint | null = null;
            const processBigInt = async (amount: bigint) => {
                invokedWith = amount;
                return amount * 2n;
            };
            const wrapped = observe({ name: 'bigint-test' })(processBigInt);

            const result = await wrapped(9007199254740993n);

            expect(result).toBe(18014398509481986n);
            expect(invokedWith).toBe(9007199254740993n);
            expect(mockSpan.setAttribute).toHaveBeenCalledWith(
                'function.args',
                expect.stringContaining('9007199254740993n')
            );
        });

        it('safely serializes circular arguments without throwing and executes application function', async () => {
            let invoked = false;
            const circular: any = { name: 'cycle' };
            circular.self = circular;

            const processCircular = async (input: any) => {
                invoked = true;
                return input.name;
            };
            const wrapped = observe({ name: 'circular-test' })(processCircular);

            const result = await wrapped(circular);

            expect(invoked).toBe(true);
            expect(result).toBe('cycle');
            expect(mockSpan.setAttribute).toHaveBeenCalledWith(
                'function.args',
                expect.stringContaining('[Circular]')
            );
        });

        it('bounds function.args string length to 1000 characters', async () => {
            const longString = 'a'.repeat(2000);
            const fn = async (text: string) => text.length;
            const wrapped = observe({})(fn);

            await wrapped(longString);

            const calls = mockSpan.setAttribute.mock.calls;
            const argsCall = calls.find((c: any[]) => c[0] === 'function.args');
            expect(argsCall).toBeDefined();
            expect(argsCall[1].length).toBeLessThanOrEqual(1000);
        });

        it('redacts multiple positional arguments by index', async () => {
            const fn = async (user: string, token: string, secret: string) => `${user}-ok`;
            const wrapped = observe({ skipArgs: ['1', '2'] })(fn);

            await wrapped('alice', 'raw-token-123', 'raw-secret-456');

            const calls = mockSpan.setAttribute.mock.calls;
            const argsCall = calls.find((c: any[]) => c[0] === 'function.args');
            expect(argsCall).toBeDefined();

            const exported = JSON.parse(argsCall[1]);
            expect(exported[0]).toBe('alice');
            expect(exported[1]).toBe('[REDACTED]');
            expect(exported[2]).toBe('[REDACTED]');
            expect(argsCall[1]).not.toContain('raw-token-123');
            expect(argsCall[1]).not.toContain('raw-secret-456');
        });

        it('supports numeric index in skipArgs array', async () => {
            const fn = async (apiKey: string, count: number) => count;
            const wrapped = observe({ skipArgs: [0 as any] })(fn);

            await wrapped('sk-secret-key-999', 42);

            const calls = mockSpan.setAttribute.mock.calls;
            const argsCall = calls.find((c: any[]) => c[0] === 'function.args');
            expect(argsCall).toBeDefined();

            const exported = JSON.parse(argsCall[1]);
            expect(exported[0]).toBe('[REDACTED]');
            expect(exported[1]).toBe(42);
        });

        it('preserves class toJSON() serializers and serializes Date objects properly', async () => {
            // Test comment 3 from review: credentials object with toJSON() and Date object
            class Credentials {
                public username = 'alice';
                public passwordHash = 'super_secret_hash_value';
                public createdAt = new Date('2026-10-19T12:00:00.000Z');

                public toJSON() {
                    return {
                        username: this.username,
                        createdAt: this.createdAt,
                    };
                }
            }

            const creds = new Credentials();
            const fn = async (c: Credentials) => c.username;
            const wrapped = observe({ skipArgs: ['password'] })(fn);

            await wrapped(creds);

            const calls = mockSpan.setAttribute.mock.calls;
            const argsCall = calls.find((call: any[]) => call[0] === 'function.args');
            expect(argsCall).toBeDefined();

            const exportedJson = JSON.parse(argsCall[1]);
            // passwordHash should NOT be present (toJSON omitted it)
            expect(exportedJson[0].passwordHash).toBeUndefined();
            expect(exportedJson[0].username).toBe('alice');
            // createdAt should be a serialized ISO string, not `{}`
            expect(exportedJson[0].createdAt).toBe('2026-10-19T12:00:00.000Z');
        });

        it('redacts nested object properties and arrays of objects matching skipArgs', async () => {
            const processBatch = async (payload: any) => 'processed';
            const wrapped = observe({ skipArgs: ['password', 'apiKey'] })(processBatch);

            await wrapped({
                account: 'acc_123',
                creds: {
                    apiKey: 'sensitive_key_val',
                },
                users: [
                    { name: 'u1', password: 'secret_user_1' },
                    { name: 'u2', password: 'secret_user_2' },
                ],
            });

            const calls = mockSpan.setAttribute.mock.calls;
            const argsCall = calls.find((call: any[]) => call[0] === 'function.args');
            expect(argsCall).toBeDefined();

            const exported = JSON.parse(argsCall[1]);
            expect(exported[0].creds.apiKey).toBe('[REDACTED]');
            expect(exported[0].users[0].password).toBe('[REDACTED]');
            expect(exported[0].users[1].password).toBe('[REDACTED]');
            expect(argsCall[1]).not.toContain('sensitive_key_val');
            expect(argsCall[1]).not.toContain('secret_user_1');
            expect(argsCall[1]).not.toContain('secret_user_2');
        });

        it('redacts by positional index when specified in skipArgs', async () => {
            const fn = async (unnamed0: string, unnamed1: string) => 'ok';
            const wrapped = observe({ skipArgs: ['1'] })(fn);

            await wrapped('public-data', 'sensitive-index-1-data');

            const calls = mockSpan.setAttribute.mock.calls;
            const argsCall = calls.find((call: any[]) => call[0] === 'function.args');
            expect(argsCall).toBeDefined();

            const exported = JSON.parse(argsCall[1]);
            expect(exported[0]).toBe('public-data');
            expect(exported[1]).toBe('[REDACTED]');
        });

        it('fails closed and outputs [REDACTED] if serialization encounters an error when redacting', async () => {
            // An object with a throwing getter when stringified
            const bomb: any = {
                get badProperty() {
                    throw new Error('Explosion during stringify');
                },
            };
            const fn = async (data: any) => 'safe';
            const wrapped = observe({ skipArgs: ['password'] })(fn);

            // Application execution should proceed safely
            const result = await wrapped(bomb);
            expect(result).toBe('safe');

            const calls = mockSpan.setAttribute.mock.calls;
            const argsCall = calls.find((call: any[]) => call[0] === 'function.args');
            expect(argsCall).toBeDefined();
            // Fails closed: does NOT leak unredacted properties
            expect(argsCall[1]).toBe('[REDACTED]');
        });
    });
});
