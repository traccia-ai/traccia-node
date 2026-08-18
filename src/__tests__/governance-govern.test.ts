import { AgentBlockedError } from '../governance/policy';

jest.mock('../governance/policy', () => ({
    checkAgentStatus: jest.fn(),
    AgentBlockedError: jest.requireActual('../governance/policy').AgentBlockedError,
}));

jest.mock('../config/runtime-config', () => ({
    runIdentity: jest.fn((_identity: unknown, fn: () => unknown) => fn()),
}));

import { govern } from '../governance/govern';
import { checkAgentStatus } from '../governance/policy';
import { runIdentity } from '../config/runtime-config';

describe('govern', () => {
    const mockCheckAgentStatus = checkAgentStatus as jest.Mock;
    const mockRunIdentity = runIdentity as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockCheckAgentStatus.mockReset().mockResolvedValue(undefined);
        mockRunIdentity.mockReset().mockImplementation((_identity: unknown, fn: () => unknown) => fn());
        delete process.env.TRACCIA_AGENT_ID;
    });

    describe('as a plain function wrapper', () => {
        it('wraps a plain function (target is function, no propertyKey/descriptor)', async () => {
            const fn = jest.fn().mockReturnValue('result');
            const wrapped = govern({ agentId: 'agent-1' })(fn) as (...args: unknown[]) => unknown;

            const result = await wrapped('a', 'b');

            expect(result).toBe('result');
            expect(fn).toHaveBeenCalledWith('a', 'b');
        });
    });

    describe('as a method decorator', () => {
        it('wraps descriptor.value and preserves it as a callable method', async () => {
            const original = jest.fn().mockReturnValue('method-result');
            const descriptor: PropertyDescriptor = { value: original };

            const returned = govern({ agentId: 'agent-1' })({}, 'myMethod', descriptor);

            expect(returned).toBe(descriptor);
            expect(descriptor.value).not.toBe(original);

            const result = await descriptor.value();
            expect(result).toBe('method-result');
            expect(original).toHaveBeenCalled();
        });

        it('preserves `this` binding through to the wrapped method', async () => {
            class Service {
                public value = 42;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                method(this: any) {
                    return this.value;
                }
            }

            const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, 'method')!;
            const wrappedDescriptor = govern({ agentId: 'agent-1' })(Service.prototype, 'method', descriptor);
            Object.defineProperty(Service.prototype, 'method', wrappedDescriptor);

            const instance = new Service();
            const result = await instance.method();

            expect(result).toBe(42);
        });
    });

    describe('default options and name resolution', () => {
        it('works with govern() called with no options at all', async () => {
            const fn = jest.fn().mockReturnValue('ok');
            const wrapped = govern()(fn) as (...args: unknown[]) => unknown;

            const result = await wrapped();

            expect(result).toBe('ok');
        });

        it('falls back to a synthetic "method" name when neither propertyKey nor options.name is set', async () => {
            const original = jest.fn().mockReturnValue('ok');
            const descriptor: PropertyDescriptor = { value: original };

            govern({ agentId: 'agent-1' })({}, undefined, descriptor);

            await expect(descriptor.value()).resolves.toBe('ok');
        });

        it('falls back to a synthetic "function" name when target is anonymous and options.name is absent', async () => {
            const fn = function () {
                return 'ok';
            };
            Object.defineProperty(fn, 'name', { value: '' });

            const wrapped = govern({ agentId: 'agent-1' })(fn) as (...args: unknown[]) => unknown;

            await expect(wrapped()).resolves.toBe('ok');
        });
    });

    describe('fallback for non-function/non-method targets', () => {
        it('returns the target unchanged when neither shape matches', () => {
            const target = { notAFunction: true };
            const result = govern({ agentId: 'agent-1' })(target, undefined, undefined);

            expect(result).toBe(target);
        });
    });

    describe('agentId resolution', () => {
        it('calls checkAgentStatus with the explicit agentId option', async () => {
            const fn = jest.fn().mockReturnValue('ok');
            const wrapped = govern({ agentId: 'explicit-agent' })(fn) as (...args: unknown[]) => unknown;

            await wrapped();

            expect(mockCheckAgentStatus).toHaveBeenCalledWith('explicit-agent', { failOpen: true });
        });

        it('falls back to TRACCIA_AGENT_ID env var when agentId option is absent', async () => {
            process.env.TRACCIA_AGENT_ID = 'env-agent';
            const fn = jest.fn().mockReturnValue('ok');
            const wrapped = govern({})(fn) as (...args: unknown[]) => unknown;

            await wrapped();

            expect(mockCheckAgentStatus).toHaveBeenCalledWith('env-agent', { failOpen: true });
        });

        it('warns and skips the policy check when neither agentId nor TRACCIA_AGENT_ID is set', async () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const fn = jest.fn().mockReturnValue('ok');
            const wrapped = govern({})(fn) as (...args: unknown[]) => unknown;

            const result = await wrapped();

            expect(result).toBe('ok');
            expect(mockCheckAgentStatus).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('No agentId provided to govern()'),
            );

            warnSpy.mockRestore();
        });
    });

    describe('failOpen option', () => {
        it('passes failOpen: false through to checkAgentStatus', async () => {
            const fn = jest.fn().mockReturnValue('ok');
            const wrapped = govern({ agentId: 'agent-1', failOpen: false })(fn) as (
                ...args: unknown[]
            ) => unknown;

            await wrapped();

            expect(mockCheckAgentStatus).toHaveBeenCalledWith('agent-1', { failOpen: false });
        });
    });

    describe('blocking behavior', () => {
        it('propagates AgentBlockedError and never invokes the wrapped function', async () => {
            mockCheckAgentStatus.mockRejectedValue(new AgentBlockedError('blocked'));
            const fn = jest.fn().mockReturnValue('should not run');
            const wrapped = govern({ agentId: 'agent-1' })(fn) as (...args: unknown[]) => unknown;

            await expect(wrapped()).rejects.toThrow(AgentBlockedError);
            expect(fn).not.toHaveBeenCalled();
        });
    });

    describe('identity propagation', () => {
        it('calls runIdentity with agentId and agent.name from attributes', async () => {
            const fn = jest.fn().mockReturnValue('ok');
            const wrapped = govern({
                agentId: 'agent-1',
                attributes: { 'agent.name': 'my-agent' },
            })(fn) as (...args: unknown[]) => unknown;

            await wrapped();

            expect(mockRunIdentity).toHaveBeenCalledWith(
                { agentId: 'agent-1', agentName: 'my-agent' },
                expect.any(Function),
            );
        });
    });

    describe('integration with real observe()', () => {
        it('actually traces the call via observe() when unmocked', async () => {
            jest.resetModules();
            jest.doMock('../governance/policy', () => ({
                checkAgentStatus: jest.fn().mockResolvedValue(undefined),
                AgentBlockedError: jest.requireActual('../governance/policy').AgentBlockedError,
            }));
            jest.doMock('../config/runtime-config', () => ({
                runIdentity: jest.fn((_identity: unknown, fn: () => unknown) => fn()),
            }));

            const mockSpan = {
                setAttribute: jest.fn(),
                end: jest.fn(),
                recordException: jest.fn(),
            };
            const mockTracer = {
                startActiveSpan: jest.fn((_name: string, fn: (span: unknown) => unknown) => fn(mockSpan)),
            };
            jest.doMock('../auto', () => ({
                getTracer: jest.fn().mockReturnValue(mockTracer),
            }));

            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { govern: freshGovern } = require('../governance/govern');

            const fn = jest.fn().mockReturnValue('traced-result');
            const wrapped = freshGovern({ agentId: 'agent-1', name: 'my-op' })(fn);
            const result = await wrapped();

            expect(result).toBe('traced-result');
            expect(mockTracer.startActiveSpan).toHaveBeenCalledWith('my-op', expect.any(Function));
            expect(mockSpan.end).toHaveBeenCalled();

            jest.dontMock('../governance/policy');
            jest.dontMock('../config/runtime-config');
            jest.dontMock('../auto');
        });
    });
});
