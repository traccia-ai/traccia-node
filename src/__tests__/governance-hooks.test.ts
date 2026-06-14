import { GovernanceManager } from '../governance/hooks';
import { ISpan, SpanStatus } from '../types';

describe('GovernanceManager', () => {
  let manager: GovernanceManager;
  let mockSpan: ISpan;

  beforeEach(() => {
    manager = new GovernanceManager();
    mockSpan = {
      name: 'test-span',
      context: { traceId: '1', spanId: '2', traceFlags: 1 },
      attributes: {},
      events: [],
      status: SpanStatus.UNSET,
      startTimeNs: 0,
      durationNs: undefined,
      setAttribute: jest.fn(),
      addEvent: jest.fn(),
      recordException: jest.fn(),
      end: jest.fn(),
      isRecording: () => true,
    };
  });

  it('should register hooks', () => {
    const hook = { onBeforeExecute: jest.fn() };
    manager.registerHooks(hook);
    // @ts-ignore
    expect(manager.hooks).toContain(hook);
  });

  it('should trigger onBeforeExecute safely', () => {
    const hook = { onBeforeExecute: jest.fn() };
    manager.registerHooks(hook);
    
    const schema = { input: 'test' };
    manager.triggerBeforeExecute(mockSpan, schema);
    
    expect(hook.onBeforeExecute).toHaveBeenCalledWith(mockSpan, schema);
  });

  it('should swallow exceptions from hooks', () => {
    const hook = { 
      onBeforeExecute: jest.fn().mockImplementation(() => { throw new Error('Hook error') }) 
    };
    manager.registerHooks(hook);
    
    // Should not throw
    expect(() => manager.triggerBeforeExecute(mockSpan, {})).not.toThrow();
  });

  it('should trigger onAfterExecute', () => {
    const hook = { onAfterExecute: jest.fn() };
    manager.registerHooks(hook);
    
    manager.triggerAfterExecute(mockSpan, {}, 'result');
    expect(hook.onAfterExecute).toHaveBeenCalledWith(mockSpan, {}, 'result');
  });

  it('should trigger onPolicyViolation', () => {
    const hook = { onPolicyViolation: jest.fn() };
    manager.registerHooks(hook);
    
    const error = new Error('Violation');
    manager.triggerPolicyViolation(mockSpan, error);
    expect(hook.onPolicyViolation).toHaveBeenCalledWith(mockSpan, error);
  });
});
