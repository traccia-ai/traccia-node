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

    it('names a "custom" span type with its name', () => {
      processor.onSpanStart({ spanId: 'custom-1', spanData: { type: 'custom', name: 'my-custom-span' } });
      expect(mockTracer.startSpan).toHaveBeenCalledWith('agent.custom.my-custom-span', expect.any(Object));
    });

    it('names function/handoff/response spans correctly', () => {
      processor.onSpanStart({ spanId: 'fn-1', spanData: { type: 'function', name: 'search' } });
      expect(mockTracer.startSpan).toHaveBeenCalledWith('agent.tool.search', expect.any(Object));

      processor.onSpanStart({ spanId: 'ho-1', spanData: { type: 'handoff' } });
      expect(mockTracer.startSpan).toHaveBeenCalledWith('agent.handoff', expect.any(Object));

      processor.onSpanStart({ spanId: 'resp-1', spanData: { type: 'response' } });
      expect(mockTracer.startSpan).toHaveBeenCalledWith('agent.response', expect.any(Object));
    });

    it('extracts agent.tool.name for function spans', () => {
      processor.onSpanStart({ spanId: 'fn-2', spanData: { type: 'function', name: 'calculator' } });
      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'agent.tool.calculator',
        expect.objectContaining({ 'agent.tool.name': 'calculator' }),
      );
    });

    it('sets agent.tool.input/output on function span end', () => {
      processor.onSpanStart({ spanId: 'fn-3', spanData: { type: 'function', name: 'calc' } });
      const mockSpanObj = mockTracer.startSpan.mock.results[0].value;

      processor.onSpanEnd({
        spanId: 'fn-3',
        spanData: { type: 'function', name: 'calc', input: '2+2', output: '4' },
      });

      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('agent.tool.input', '2+2');
      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('agent.tool.output', '4');
    });

    it('sets agent.response.id on response span end', () => {
      processor.onSpanStart({ spanId: 'resp-2', spanData: { type: 'response' } });
      const mockSpanObj = mockTracer.startSpan.mock.results[0].value;

      processor.onSpanEnd({
        spanId: 'resp-2',
        spanData: { type: 'response', response: { id: 'resp-abc' } },
      });

      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('agent.response.id', 'resp-abc');
    });

    it('falls back to legacy prompt_tokens/completion_tokens usage field names', () => {
      processor.onSpanStart({ spanId: 'gen-legacy', spanData: { type: 'generation' } });
      const mockSpanObj = mockTracer.startSpan.mock.results[0].value;

      processor.onSpanEnd({
        spanId: 'gen-legacy',
        spanData: { type: 'generation', usage: { prompt_tokens: 5, completion_tokens: 3 } },
      });

      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('llm.usage.input_tokens', 5);
      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('llm.usage.output_tokens', 3);
      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('llm.usage.total_tokens', 8);
    });

    it('omits total_tokens when only one of input/output tokens is present', () => {
      processor.onSpanStart({ spanId: 'gen-partial', spanData: { type: 'generation' } });
      const mockSpanObj = mockTracer.startSpan.mock.results[0].value;

      processor.onSpanEnd({
        spanId: 'gen-partial',
        spanData: { type: 'generation', usage: { input_tokens: 5 } },
      });

      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('llm.usage.input_tokens', 5);
      expect(mockSpanObj.setAttribute).not.toHaveBeenCalledWith('llm.usage.total_tokens', expect.anything());
    });

    it('falls back to String() when JSON.stringify throws for generation input/output', () => {
      processor.onSpanStart({ spanId: 'gen-circular', spanData: { type: 'generation' } });
      const mockSpanObj = mockTracer.startSpan.mock.results[0].value;

      const circular: any = {};
      circular.self = circular;

      processor.onSpanEnd({
        spanId: 'gen-circular',
        spanData: { type: 'generation', input: circular, output: circular },
      });

      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('llm.input', expect.stringContaining('[object Object]'));
      expect(mockSpanObj.setAttribute).toHaveBeenCalledWith('llm.output', expect.stringContaining('[object Object]'));
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
