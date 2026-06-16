import { install } from '../integrations/openai-agents';
import { TracciaAgentsTracingProcessor } from '../integrations/openai-agents/processor';

const mockTracer = {
  startSpan: jest.fn().mockImplementation(() => {
    return {
      setAttribute: jest.fn(),
      end: jest.fn(),
    };
  }),
};

jest.mock('../index', () => ({
  getTracer: jest.fn().mockReturnValue(mockTracer),
}));

describe('openai-agents integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    jest.isolateModules(() => {
      // clear instrumented flag
    });
  });

  describe('install', () => {
    it('should return false if enabled is false', () => {
      const result = install(false);
      expect(result).toBe(false);
    });

    it('should return true if already installed', () => {
      const { install: isolatedInstall } = require('../integrations/openai-agents');
      // Mock agents to succeed
      jest.doMock('@openai/agents', () => ({
        addTraceProcessor: jest.fn()
      }), { virtual: true });
      
      isolatedInstall();
      const result = isolatedInstall();
      expect(result).toBe(true);
    });

    it('should return false if agents module is not available', () => {
      jest.doMock('@openai/agents', () => {
        throw new Error('module not found');
      }, { virtual: true });
      
      const { install: isolatedInstall } = require('../integrations/openai-agents');
      const result = isolatedInstall();
      expect(result).toBe(false);
    });

    it('should return false if addTraceProcessor is not present', () => {
      jest.doMock('@openai/agents', () => ({}), { virtual: true });
      
      const { install: isolatedInstall } = require('../integrations/openai-agents');
      const result = isolatedInstall();
      expect(result).toBe(false);
    });

    it('should install processor successfully', () => {
      const mockAddTraceProcessor = jest.fn();
      jest.doMock('@openai/agents', () => ({
        addTraceProcessor: mockAddTraceProcessor
      }), { virtual: true });
      
      const { install: isolatedInstall } = require('../integrations/openai-agents');
      const result = isolatedInstall();
      expect(result).toBe(true);
      expect(mockAddTraceProcessor).toHaveBeenCalledWith(
        expect.objectContaining({
          spanMap: expect.any(Map),
          traceMap: expect.any(Map)
        })
      );
    });
  });
});

describe('TracciaAgentsTracingProcessor', () => {
  let processor: TracciaAgentsTracingProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new TracciaAgentsTracingProcessor();
  });

  describe('trace management', () => {
    it('should track trace start and end', () => {
      const trace = { traceId: 'test-trace' };
      processor.onTraceStart(trace);
      expect((processor as any).traceMap.has('test-trace')).toBe(true);
      
      processor.onTraceEnd(trace);
      expect((processor as any).traceMap.has('test-trace')).toBe(false);
    });
  });

  describe('span management', () => {
    it('should start span for agent', () => {
      const span = {
        spanId: 'span-1',
        spanData: { type: 'agent', name: 'my-agent' }
      };

      processor.onSpanStart(span);
      
      expect(mockTracer.startSpan).toHaveBeenCalledWith('agent.my-agent', expect.objectContaining({
        'agent.span.type': 'agent',
        'agent.name': 'my-agent'
      }));
      expect((processor as any).spanMap.has('span-1')).toBe(true);
    });

    it('should handle span end and record attributes for generation', () => {
      const spanStart = {
        spanId: 'span-2',
        spanData: { type: 'generation' }
      };
      
      processor.onSpanStart(spanStart);
      const mockSpanObj = mockTracer.startSpan.mock.results[0].value;

      const spanEnd = {
        spanId: 'span-2',
        spanData: {
          type: 'generation',
          usage: { prompt_tokens: 10, completion_tokens: 20 },
          input: 'hello',
          output: 'world'
        }
      };

      processor.onSpanEnd(spanEnd);

      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('llm.usage.prompt_tokens', 10);
      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('llm.usage.completion_tokens', 20);
      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('llm.usage.total_tokens', 30);
      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('llm.input', '"hello"');
      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('llm.output', '"world"');
      expect(mockSpanObj.end).toHaveBeenCalled();
      expect((processor as any).spanMap.has('span-2')).toBe(false);
    });

    it('should ignore span end if not found', () => {
      processor.onSpanEnd({ spanId: 'unknown', spanData: { type: 'agent' } });
      // should not throw
    });

    it('should record errors on span end', () => {
      processor.onSpanStart({ spanId: 'span-err', spanData: { type: 'agent' } });
      const mockSpanObj = mockTracer.startSpan.mock.results[0].value;

      processor.onSpanEnd({
        spanId: 'span-err',
        spanData: { type: 'agent' },
        error: { message: 'something failed' }
      });

      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('error', true);
      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('error.message', 'something failed');
    });

    it('should record guardrail findings on span end', () => {
      processor.onSpanStart({ spanId: 'span-gr', spanData: { type: 'guardrail', name: 'toxicity' } });
      const mockSpanObj = mockTracer.startSpan.mock.results[0].value;

      processor.onSpanEnd({
        spanId: 'span-gr',
        spanData: { type: 'guardrail', name: 'toxicity', triggered: true }
      });

      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('agent.guardrail.triggered', true);
      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('guardrail.findings', expect.any(String));
    });

    it('should fallback to unknown span name', () => {
      processor.onSpanStart({ spanId: 'span-3', spanData: { type: 'custom_thing' } });
      expect(mockTracer.startSpan).toHaveBeenCalledWith('agent.custom_thing', expect.any(Object));
    });
  });

  describe('lifecycle', () => {
    it('should clear maps on shutdown', () => {
      processor.onTraceStart({ traceId: 't1' });
      processor.onSpanStart({ spanId: 's1', spanData: { type: 'agent' } });
      
      processor.shutdown();
      
      expect((processor as any).traceMap.size).toBe(0);
      expect((processor as any).spanMap.size).toBe(0);
    });

    it('should have a noop forceFlush', () => {
      expect(() => processor.forceFlush()).not.toThrow();
    });
  });
});
