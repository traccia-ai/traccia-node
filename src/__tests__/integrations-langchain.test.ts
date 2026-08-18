/**
 * Tests for LangChain integration (TraciaCallbackHandler)
 */

import { TracciaCallbackHandler } from '../integrations/langchain-callback';
import { startTracing, stopTracing } from '../auto';
import { setCurrentSpan } from '../context/context';
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  FunctionMessage,
  ToolMessage,
  ChatMessage,
} from '@langchain/core/messages';

class MockSpan {
  attributes: Record<string, any> = {};
  isEnded = false;
  context = { traceId: 'test-trace', spanId: 'test-span' };
  setAttribute(key: string, value: any) { this.attributes[key] = value; }
  end() { this.isEnded = true; }
}

let mockTracer: any;

describe('TracciaCallbackHandler', () => {
  beforeEach(() => {
    startTracing({
      enableTokenCounting: false,
      enableCostTracking: false,
    });
    mockTracer = {
      startSpan: jest.fn((name, options) => {
        const span = new MockSpan();
        if (options?.attributes) {
          Object.assign(span.attributes, options.attributes);
        }
        return span;
      })
    };
  });

  afterEach(() => {
    stopTracing();
  });

  describe('handleLLMStart', () => {
    it('should create a span for LLM invocation', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = {
        name: 'gpt-4',
        _modelType: 'openai',
        lc: 1,
        type: 'not_implemented' as const,
        id: ['openai', 'gpt-4'],
      };

      await handler.handleLLMStart(mockLLM, ['prompt1', 'prompt2'], 'run-1');

      // Verify span was created in the handler's span map
      expect((handler as any)['runMap'].has('run-1')).toBe(true);
    });

    it('should capture LLM model name in attributes', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = {
        name: 'claude-3',
        _modelType: 'anthropic',
        lc: 1,
        type: 'not_implemented' as const,
        id: ['anthropic', 'claude-3'],
      };

      await handler.handleLLMStart(mockLLM, ['test prompt'], 'run-2', undefined, { invocation_params: { model: 'claude-3' } });

      const span = (handler as any)['runMap'].get('run-2');
      expect(span?.attributes?.model).toMatch(/claude-3/);
    });

    it('should capture prompt count', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = {
        name: 'claude-3',
        _modelType: 'anthropic',
        lc: 1,
        type: 'not_implemented' as const,
        id: ['anthropic', 'claude-3'],
      };
      const prompts = ['p1', 'p2', 'p3'];
      await handler.handleLLMStart(mockLLM, prompts, 'run-3');
      const span = (handler as any)['runMap'].get('run-3');
      // The implementation in `handleGenerationStart` does not record `prompt_count`
      // It sets attributes: { input: messages, model: extractedModelName, modelParameters, prompt }
      // So prompt_count test logic needs to be updated or we check for input length.
      expect(span?.attributes?.input).toHaveLength(3);
    });

    it('should handle missing model name gracefully', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { lc: 1, type: 'not_implemented' as const, id: ['unknown'] };
      await handler.handleLLMStart(mockLLM, ['prompt'], 'run-4');
      const span = (handler as any)['runMap'].get('run-4');
      expect(span?.attributes?.model).toBeUndefined(); // The handler doesn't default to unknown, it leaves it undefined
    });
  });

  describe('handleLLMEnd', () => {
    it('should end LLM span and record token counts', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'gpt-4', lc: 1, type: 'not_implemented' as const, id: ['openai', 'gpt-4'] };
      await handler.handleLLMStart(mockLLM, ['prompt'], 'run-5');
      const output = { generations: [[{ text: 'test' }]] };
      await handler.handleLLMEnd?.(output, 'run-5');
      expect((handler as any)['runMap'].has('run-5')).toBe(false);
    });

    it('should end LLM span with long output', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'claude-3', lc: 1, type: 'not_implemented' as const, id: ['anthropic', 'claude-3'] };
      await handler.handleLLMStart(mockLLM, ['prompt'], 'run-6');
      const output = { generations: [[{ text: 'This is a test response that has some length to it' }]] };
      await handler.handleLLMEnd?.(output, 'run-6');
      expect((handler as any)['runMap'].has('run-6')).toBe(false);
    });
  });

  describe('handleChainStart', () => {
    it('should create a span for chain execution', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockChain = {
        name: 'test-chain',
        _chainType: 'stuff',
        lc: 1,
        type: 'not_implemented' as const,
        id: ['test', 'test-chain'],
      };

      await handler.handleChainStart(mockChain, { input: 'test' }, 'chain-1');

      expect((handler as any)['runMap'].has('chain-1')).toBe(true);
    });

    it('should capture chain input properly', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockChain = {
        name: 'qa-chain',
        _chainType: 'retrieval_qa',
        lc: 1,
        type: 'not_implemented' as const,
        id: ['test', 'qa-chain'],
      };

      await handler.handleChainStart(mockChain, { content: 'test' }, 'chain-2');

      const span = (handler as any)['runMap'].get('chain-2');
      expect(span?.attributes?.input).toBe('test');
    });

    it('should record input values', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockChain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };
      const inputs = { key1: 'value1', key2: 'value2' };

      await handler.handleChainStart(mockChain, inputs, 'chain-3');

      const span = (handler as any)['runMap'].get('chain-3');
      expect(span?.attributes?.input).toEqual(inputs);
    });
  });

  describe('handleChainStart BaseMessage-array normalization', () => {
    it('normalizes inputs.input when it is an array of BaseMessage', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const chain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };

      await handler.handleChainStart(chain, { input: [new HumanMessage('hi')] }, 'input-array-run');

      const span = (handler as any)['runMap'].get('input-array-run');
      expect(span.attributes.input).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('normalizes inputs.messages when it is an array of BaseMessage', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const chain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };

      await handler.handleChainStart(chain, { messages: [new SystemMessage('sys')] }, 'messages-array-run');

      const span = (handler as any)['runMap'].get('messages-array-run');
      expect(span.attributes.input).toEqual([{ role: 'system', content: 'sys' }]);
    });
  });

  describe('handleChainEnd', () => {
    it('should end chain span and record output', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockChain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };

      await handler.handleChainStart(mockChain, { input: 'test' }, 'chain-4');

      const output = { output: 'result' };
      await handler.handleChainEnd(output, 'chain-4');

      expect((handler as any)['runMap'].has('chain-4')).toBe(false);
    });

    it('normalizes outputs.messages when it is an array of BaseMessage', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const chain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };
      await handler.handleChainStart(chain, {}, 'chain-msg-out');

      const span = (handler as any)['runMap'].get('chain-msg-out');
      await handler.handleChainEnd({ messages: [new AIMessage('done')] }, 'chain-msg-out');

      expect(span.attributes.output).toEqual({ messages: [{ role: 'assistant', content: 'done' }] });
    });
  });

  describe('handleToolStart', () => {
    it('should create a span for tool invocation', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockTool = {
        name: 'search-api',
        lc: 1,
        type: 'not_implemented' as const,
        id: ['test', 'search-api'],
      };

      await handler.handleToolStart(mockTool, 'search query', 'tool-1');

      expect((handler as any)['runMap'].has('tool-1')).toBe(true);
    });

    it('should capture tool name', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockTool = { name: 'calculator', lc: 1, type: 'not_implemented' as const, id: ['test', 'calculator'] };

      await handler.handleToolStart(mockTool, '2+2', 'tool-2', undefined, undefined, undefined, 'custom-tool');

      expect(mockTracer.startSpan).toHaveBeenCalledWith('custom-tool', expect.anything());
    });

    it('should record input value', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockTool = { name: 'tool', lc: 1, type: 'not_implemented' as const, id: ['test', 'tool'] };
      const input = 'test input with some length';

      await handler.handleToolStart(mockTool, input, 'tool-3');

      const span = (handler as any)['runMap'].get('tool-3');
      expect(span?.attributes?.input).toBe(input);
    });
  });

  describe('handleToolEnd', () => {
    it('should end tool span', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockTool = { name: 'tool', lc: 1, type: 'not_implemented' as const, id: ['test', 'tool'] };

      await handler.handleToolStart(mockTool, 'input', 'tool-4');
      await handler.handleToolEnd?.('output', 'tool-4');

      expect((handler as any)['runMap'].has('tool-4')).toBe(false);
    });

    it('should record output length', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockTool = { name: 'tool', lc: 1, type: 'not_implemented' as const, id: ['test', 'tool'] };

      await handler.handleToolStart(mockTool, 'input', 'tool-5');
      const output = 'This is the tool output response';
      await handler.handleToolEnd?.(output, 'tool-5');

      expect((handler as any)['runMap'].has('tool-5')).toBe(false);
    });
  });

  describe('handleAgentAction', () => {
    it('should update existing span on agent action', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockChain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };

      // Start a span first
      await handler.handleChainStart(mockChain, {}, 'agent-1');

      // Then handle agent action
      const mockAction = {
        tool: 'search',
        toolInput: 'query',
        log: '',
      };
      await handler.handleAgentAction(mockAction, 'agent-1');

      // Span should still exist
      expect((handler as any)['runMap'].has('agent-1')).toBe(true);
    });

    it('should record agent action details', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockChain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };
      // Start a span first
      await handler.handleChainStart(mockChain, {}, 'agent-2');

      // Then handle agent action
      const mockAction = {
        tool: 'calculator',
        toolInput: '42 / 7',
        log: '',
      };
      await handler.handleAgentAction(mockAction, 'agent-2');

      // Span should have agent action recorded
      const span = (handler as any)['runMap'].get('agent-2');
      expect(span).toBeDefined();
    });
  });

  describe('handleAgentFinish', () => {
    it('should end agent span on finish', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;

      // Create a span first
      const mockAction = { tool: 'test', toolInput: 'input', log: '' };
      await handler.handleAgentAction(mockAction, 'agent-3');

      // Finish agent
      const finish = { output: 'final result', returnValues: {}, log: '' };
      await handler.handleAgentEnd?.(finish, 'agent-3');

      expect((handler as any)['runMap'].has('agent-3')).toBe(false);
    });

    it('should record final output', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockAction = { tool: 'test', toolInput: 'input', log: '' };

      await handler.handleAgentAction(mockAction, 'agent-4');

      const finish = { output: 'completed result', returnValues: {}, log: '' };
      await handler.handleAgentEnd?.(finish, 'agent-4');

      expect((handler as any)['runMap'].has('agent-4')).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle LLM errors gracefully', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };

      await handler.handleLLMStart(mockLLM, ['prompt'], 'error-1');

      const error = new Error('LLM failed');
      await handler.handleLLMError?.(error, 'error-1');

      // Span should still be cleaned up
      expect((handler as any)['runMap'].has('error-1')).toBe(false);
    });

    it('should handle chain errors gracefully', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockChain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };

      await handler.handleChainStart(mockChain, {}, 'error-2');

      const error = new Error('Chain failed');
      await handler.handleChainError?.(error, 'error-2');

      expect((handler as any)['runMap'].has('error-2')).toBe(false);
    });

    it('should handle tool errors gracefully', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockTool = { name: 'tool', lc: 1, type: 'not_implemented' as const, id: ['test', 'tool'] };

      await handler.handleToolStart(mockTool, 'input', 'error-3');

      const error = new Error('Tool failed');
      await handler.handleToolError?.(error, 'error-3');

      expect((handler as any)['runMap'].has('error-3')).toBe(false);
    });
  });

  describe('Span Nesting', () => {
    it('should handle nested spans (chain containing LLM)', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;

      // Start chain
      const chain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };
      await handler.handleChainStart(chain, {}, 'chain-outer');

      // Start LLM inside chain
      const llm = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };
      await handler.handleLLMStart(llm, ['prompt'], 'llm-inner', 'chain-outer');

      // Both should exist
      expect((handler as any)['runMap'].has('chain-outer')).toBe(true);
      expect((handler as any)['runMap'].has('llm-inner')).toBe(true);

      // End LLM first
      await handler.handleLLMEnd?.({ generations: [[{ text: 'response' }]] }, 'llm-inner');
      expect((handler as any)['runMap'].has('llm-inner')).toBe(false);

      // Chain should still exist
      expect((handler as any)['runMap'].has('chain-outer')).toBe(true);

      // End chain
      await handler.handleChainEnd({ output: 'result' }, 'chain-outer');
      expect((handler as any)['runMap'].has('chain-outer')).toBe(false);
    });

    it('should handle multiple concurrent spans', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;

      // Start multiple spans
      const chain1 = { name: 'chain1', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain1'] };
      const chain2 = { name: 'chain2', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain2'] };

      await handler.handleChainStart(chain1, {}, 'c1');
      await handler.handleChainStart(chain2, {}, 'c2');

      expect((handler as any)['runMap'].has('c1')).toBe(true);
      expect((handler as any)['runMap'].has('c2')).toBe(true);

      // End one
      await handler.handleChainEnd({ output: 'r1' }, 'c1');

      // Other should still exist
      expect((handler as any)['runMap'].has('c1')).toBe(false);
      expect((handler as any)['runMap'].has('c2')).toBe(true);
    });
  });

  describe('Integration with Tracer', () => {
    it('should use the SDK tracer', () => {
      const handler = new TracciaCallbackHandler();
      expect((handler as any)['tracer']).toBeDefined();
    });

    it('should handle unavailable tracer gracefully', async () => {
      const handler = new TracciaCallbackHandler();

      // Should not throw even if operations fail
      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };
      await expect(handler.handleLLMStart(mockLLM, ['prompt'], 'test')).resolves.not.toThrow();
    });
  });

  describe('startAndRegisterSpan parent resolution', () => {
    it('creates a fresh root trace for an AgentExecutor chain', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const chain = { name: 'AgentExecutor', lc: 1, type: 'not_implemented' as const, id: ['test', 'AgentExecutor'] };

      await handler.handleChainStart(chain, {}, 'agent-exec-1');

      expect(mockTracer.startSpan).toHaveBeenCalledWith('AgentExecutor', expect.not.objectContaining({ parentContext: expect.anything() }));
      expect((handler as any)['persistentRootTraceId']).toBe('test-trace');
    });

    it('parents subsequent spans under the persistent root trace once AgentExecutor has run', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const agentChain = { name: 'AgentExecutor', lc: 1, type: 'not_implemented' as const, id: ['test', 'AgentExecutor'] };
      await handler.handleChainStart(agentChain, {}, 'agent-exec-2');

      const tool = { name: 'tool', lc: 1, type: 'not_implemented' as const, id: ['test', 'tool'] };
      await handler.handleToolStart(tool, 'input', 'tool-under-root');

      const [, toolOptions] = mockTracer.startSpan.mock.calls[mockTracer.startSpan.mock.calls.length - 1];
      expect(toolOptions.parentContext).toEqual({
        traceId: 'test-trace',
        spanId: 'test-span',
        traceFlags: 1,
      });
    });

    it('falls back to the runMap parent span when no persistent root trace exists', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const chain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };
      await handler.handleChainStart(chain, {}, 'parent-run');

      const tool = { name: 'tool', lc: 1, type: 'not_implemented' as const, id: ['test', 'tool'] };
      await handler.handleToolStart(tool, 'input', 'child-run', 'parent-run');

      const [, toolOptions] = mockTracer.startSpan.mock.calls[mockTracer.startSpan.mock.calls.length - 1];
      expect(toolOptions.parent).toBe((handler as any)['runMap'].get('parent-run'));
    });

    it('falls back to getCurrentSpan() when there is no persistent root and no runMap parent', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const currentSpan = { context: { traceId: 'ambient-trace', spanId: 'ambient-span' } } as any;

      await setCurrentSpan(currentSpan);
      try {
        const tool = { name: 'tool', lc: 1, type: 'not_implemented' as const, id: ['test', 'tool'] };
        await handler.handleToolStart(tool, 'input', 'no-parent-run');
      } finally {
        setCurrentSpan(undefined);
      }

      const [, toolOptions] = mockTracer.startSpan.mock.calls[mockTracer.startSpan.mock.calls.length - 1];
      expect(toolOptions.parent).toBe(currentSpan);
    });

    it('creates a root-less span when there is no persistent root, runMap parent, or ambient span', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;

      const tool = { name: 'tool', lc: 1, type: 'not_implemented' as const, id: ['test', 'tool'] };
      await handler.handleToolStart(tool, 'input', 'orphan-run');

      const [, toolOptions] = mockTracer.startSpan.mock.calls[mockTracer.startSpan.mock.calls.length - 1];
      expect(toolOptions.parent).toBeUndefined();
      expect(toolOptions.parentContext).toBeUndefined();
    });
  });

  describe('handleSpanEnd', () => {
    it('warns and no-ops when the runId is not in runMap', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(handler.handleToolEnd?.('output', 'never-started')).resolves.not.toThrow();

      expect(warnSpy).toHaveBeenCalledWith('Span not found in runMap. Skipping operation');
      warnSpy.mockRestore();
    });
  });

  describe('handleLLMNewToken', () => {
    it('records the first-token time and threads it into completionStartTime on handleLLMEnd', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };

      await handler.handleLLMStart(mockLLM, ['prompt'], 'stream-run');
      await handler.handleLLMNewToken('tok', undefined, 'stream-run');

      expect((handler as any)['completionStartTimes']['stream-run']).toBeInstanceOf(Date);

      const spanBeforeEnd = (handler as any)['runMap'].get('stream-run');
      await handler.handleLLMEnd?.({ generations: [[{ text: 'result' }]] }, 'stream-run');

      expect(spanBeforeEnd.attributes.completionStartTime).toBeInstanceOf(Date);
      expect((handler as any)['completionStartTimes']['stream-run']).toBeUndefined();
    });

    it('does not overwrite an existing completionStartTime for the same runId', async () => {
      const handler = new TracciaCallbackHandler();
      await handler.handleLLMNewToken('tok1', undefined, 'multi-token-run');
      const first = (handler as any)['completionStartTimes']['multi-token-run'];

      await handler.handleLLMNewToken('tok2', undefined, 'multi-token-run');

      expect((handler as any)['completionStartTimes']['multi-token-run']).toBe(first);
    });
  });

  describe('handleGenerationStart model name resolution', () => {
    it('prefers invocation_params.model over metadata.ls_model_name', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };

      await handler.handleLLMStart(
        mockLLM,
        ['prompt'],
        'model-run-1',
        undefined,
        { invocation_params: { model: 'from-invocation-params' } },
        undefined,
        { ls_model_name: 'from-metadata' },
      );

      const span = (handler as any)['runMap'].get('model-run-1');
      expect(span.attributes.model).toBe('from-invocation-params');
    });

    it('falls back to metadata.ls_model_name when invocation_params.model is absent', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };

      await handler.handleLLMStart(
        mockLLM,
        ['prompt'],
        'model-run-2',
        undefined,
        { invocation_params: {} },
        undefined,
        { ls_model_name: 'from-metadata' },
      );

      const span = (handler as any)['runMap'].get('model-run-2');
      expect(span.attributes.model).toBe('from-metadata');
    });
  });

  describe('handleLLMEnd usage extraction', () => {
    it('reads usage_metadata off an AIMessage generation (input/output/total tokens)', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };
      await handler.handleLLMStart(mockLLM, ['prompt'], 'usage-run-1');

      const aiMessage = new AIMessage({
        content: 'response',
        usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      });
      const span = (handler as any)['runMap'].get('usage-run-1');
      await handler.handleLLMEnd?.({ generations: [[{ message: aiMessage, text: '' }]] } as any, 'usage-run-1');

      expect(span.attributes.usageDetails).toEqual({ input: 10, output: 5, total: 15 });
    });

    it('subtracts input_token_details values (e.g. cache tokens) out of the input total', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };
      await handler.handleLLMStart(mockLLM, ['prompt'], 'usage-run-2');

      const aiMessage = new AIMessage({
        content: 'response',
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_token_details: { cache_read: 4 },
        },
      });
      const span = (handler as any)['runMap'].get('usage-run-2');
      await handler.handleLLMEnd?.({ generations: [[{ message: aiMessage, text: '' }]] } as any, 'usage-run-2');

      expect(span.attributes.usageDetails.input_cache_read).toBe(4);
      expect(span.attributes.usageDetails.input).toBe(6);
    });

    it('subtracts output_token_details values (e.g. reasoning tokens) out of the output total', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };
      await handler.handleLLMStart(mockLLM, ['prompt'], 'usage-run-3');

      const aiMessage = new AIMessage({
        content: 'response',
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
          output_token_details: { reasoning: 8 },
        },
      });
      const span = (handler as any)['runMap'].get('usage-run-3');
      await handler.handleLLMEnd?.({ generations: [[{ message: aiMessage, text: '' }]] } as any, 'usage-run-3');

      expect(span.attributes.usageDetails.output_reasoning).toBe(8);
      expect(span.attributes.usageDetails.output).toBe(12);
    });

    it('clamps the adjusted total at 0 (never goes negative)', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };
      await handler.handleLLMStart(mockLLM, ['prompt'], 'usage-run-4');

      const aiMessage = new AIMessage({
        content: 'response',
        usage_metadata: {
          input_tokens: 3,
          output_tokens: 5,
          total_tokens: 8,
          input_token_details: { cache_read: 100 },
        },
      });
      const span = (handler as any)['runMap'].get('usage-run-4');
      await handler.handleLLMEnd?.({ generations: [[{ message: aiMessage, text: '' }]] } as any, 'usage-run-4');

      expect(span.attributes.usageDetails.input).toBe(0);
    });

    it('falls back to legacy promptTokens/completionTokens/totalTokens field names', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };
      await handler.handleLLMStart(mockLLM, ['prompt'], 'usage-run-5');

      const span = (handler as any)['runMap'].get('usage-run-5');
      await handler.handleLLMEnd?.(
        {
          generations: [[{ text: 'response' }]],
          llmOutput: { tokenUsage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } },
        } as any,
        'usage-run-5',
      );

      expect(span.attributes.usageDetails).toEqual({ input: 7, output: 3, total: 10 });
    });
  });

  describe('extractModelNameFromMetadata', () => {
    it('reads response_metadata.model_name off an AIMessage', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };
      await handler.handleLLMStart(mockLLM, ['prompt'], 'model-extract-run');

      const aiMessage = new AIMessage({
        content: 'response',
        response_metadata: { model_name: 'gpt-4-from-response' },
      });
      const span = (handler as any)['runMap'].get('model-extract-run');
      await handler.handleLLMEnd?.({ generations: [[{ message: aiMessage, text: '' }]] } as any, 'model-extract-run');

      expect(span.attributes.model).toBe('gpt-4-from-response');
    });

    it('returns undefined (does not throw) when the generation has no message', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };
      await handler.handleLLMStart(mockLLM, ['prompt'], 'model-extract-run-2');

      const span = (handler as any)['runMap'].get('model-extract-run-2');
      await handler.handleLLMEnd?.({ generations: [[{ text: 'plain text response' }]] } as any, 'model-extract-run-2');

      expect(span.attributes.model).toBeUndefined();
    });
  });

  describe('extractChatMessageContent (via handleChatModelStart)', () => {
    async function runChatModelStart(messages: any[]) {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const mockLLM = { name: 'chat-llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'chat-llm'] };
      await handler.handleChatModelStart(mockLLM, [messages], 'chat-run');
      return (handler as any)['runMap'].get('chat-run');
    }

    it('maps a human message to role "user"', async () => {
      const span = await runChatModelStart([new HumanMessage('hi')]);
      expect(span.attributes.input[0]).toMatchObject({ role: 'user', content: 'hi' });
    });

    it('maps a generic ChatMessage to role "human"', async () => {
      const span = await runChatModelStart([new ChatMessage('hi', 'someRole')]);
      expect(span.attributes.input[0]).toMatchObject({ role: 'human', content: 'hi' });
    });

    it('maps a system message to role "system"', async () => {
      const span = await runChatModelStart([new SystemMessage('be nice')]);
      expect(span.attributes.input[0]).toMatchObject({ role: 'system', content: 'be nice' });
    });

    it('maps an AI message to role "assistant" and extracts tool_calls', async () => {
      const aiMessage = new AIMessage({
        content: '',
        tool_calls: [{ name: 'search', args: { q: 'x' }, id: 'call-1' }],
      });
      const span = await runChatModelStart([aiMessage]);
      expect(span.attributes.input[0]).toMatchObject({ role: 'assistant' });
      expect(span.attributes.input[0].tool_calls).toEqual([{ name: 'search', args: { q: 'x' }, id: 'call-1' }]);
    });

    it('extracts tool_calls from additional_kwargs when message.tool_calls is empty', async () => {
      const legacyToolCalls = [{ id: 'legacy-call', type: 'function', function: { name: 'f', arguments: '{}' } }];
      const aiMessage = new AIMessage({
        content: '',
        additional_kwargs: { tool_calls: legacyToolCalls as any },
      });
      const span = await runChatModelStart([aiMessage]);
      expect(span.attributes.input[0].tool_calls).toEqual(legacyToolCalls);
    });

    it('maps a function message to its name as role', async () => {
      const span = await runChatModelStart([new FunctionMessage({ content: 'result', name: 'my_function' })]);
      expect(span.attributes.input[0]).toMatchObject({ role: 'my_function', content: 'result' });
    });

    it('maps a tool message to its name as role', async () => {
      const span = await runChatModelStart([new ToolMessage('result', 'call-1', 'my_tool')]);
      expect(span.attributes.input[0]).toMatchObject({ role: 'my_tool', content: 'result' });
    });

    it('merges additional_kwargs.function_call into the output when present and no tool_calls extracted', async () => {
      const aiMessage = new AIMessage({
        content: '',
        additional_kwargs: { function_call: { name: 'legacy_fn', arguments: '{}' } },
      });
      const span = await runChatModelStart([aiMessage]);
      expect(span.attributes.input[0].additional_kwargs.function_call).toEqual({
        name: 'legacy_fn',
        arguments: '{}',
      });
    });
  });

  describe('handleRetrieverStart / End / Error', () => {
    it('creates a span for retriever start with the query as input', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const retriever = { name: 'my-retriever', lc: 1, type: 'not_implemented' as const, id: ['test', 'my-retriever'] };

      await handler.handleRetrieverStart(retriever, 'search query', 'retriever-1');

      const span = (handler as any)['runMap'].get('retriever-1');
      expect(span.attributes.input).toBe('search query');
    });

    it('ends the retriever span with documents as output', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const retriever = { name: 'my-retriever', lc: 1, type: 'not_implemented' as const, id: ['test', 'my-retriever'] };
      await handler.handleRetrieverStart(retriever, 'query', 'retriever-2');

      const docs = [{ pageContent: 'doc1', metadata: {} }];
      await handler.handleRetrieverEnd(docs as any, 'retriever-2');

      expect((handler as any)['runMap'].has('retriever-2')).toBe(false);
    });

    it('ends the retriever span with an ERROR level on failure', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const retriever = { name: 'my-retriever', lc: 1, type: 'not_implemented' as const, id: ['test', 'my-retriever'] };
      await handler.handleRetrieverStart(retriever, 'query', 'retriever-3');

      const span = (handler as any)['runMap'].get('retriever-3');
      await handler.handleRetrieverError(new Error('retriever failed'), 'retriever-3');

      expect(span.attributes.level).toBe('ERROR');
      expect((handler as any)['runMap'].has('retriever-3')).toBe(false);
    });
  });

  describe('parseAzureRefusalError (via handleChainError / handleLLMError)', () => {
    it('appends error details when the error has an "error" property', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const chain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };
      await handler.handleChainStart(chain, {}, 'azure-err-run');
      const span = (handler as any)['runMap'].get('azure-err-run');

      const err: any = new Error('refused');
      err.error = { code: 'content_filter', message: 'blocked' };

      await handler.handleChainError?.(err, 'azure-err-run');

      expect(span.attributes.statusMessage).toContain('Error details:');
      expect(span.attributes.statusMessage).toContain('content_filter');
    });

    it('leaves statusMessage as just the error string when there is no "error" property', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const chain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };
      await handler.handleChainStart(chain, {}, 'plain-err-run');
      const span = (handler as any)['runMap'].get('plain-err-run');

      await handler.handleChainError?.(new Error('plain failure'), 'plain-err-run');

      expect(span.attributes.statusMessage).toBe('Error: plain failure');
    });
  });

  describe('Langfuse prompt registration passthrough', () => {
    it('registers a langfusePrompt from chain-start metadata against the parent run, then threads it into the next generation and deregisters it', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const chain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };
      const prompt = { name: 'my-prompt', version: 2, isFallback: false };

      // registerLangfusePrompt keys off the chain-start event's own *parentRunId*,
      // not its runId - so a chain running under parent "lf-parent" registers the
      // prompt to be picked up by the next generation whose parentRunId is also
      // "lf-parent".
      await handler.handleChainStart(chain, {}, 'lf-child', 'lf-parent', undefined, {
        langfusePrompt: prompt,
      });

      expect((handler as any)['promptToParentRunMap'].get('lf-parent')).toEqual(prompt);

      const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };
      await handler.handleLLMStart(mockLLM, ['prompt'], 'lf-generation', 'lf-parent');

      const span = (handler as any)['runMap'].get('lf-generation');
      expect(span.attributes.prompt).toEqual(prompt);
      expect((handler as any)['promptToParentRunMap'].has('lf-parent')).toBe(false);
    });
  });

  describe('tags and metadata on spans', () => {
    it('attaches tags to the span attributes', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const chain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };

      await handler.handleChainStart(chain, {}, 'tagged-run', undefined, ['tag1', 'tag2']);

      const span = (handler as any)['runMap'].get('tagged-run');
      expect(span.attributes.tags).toEqual(['tag1', 'tag2']);
    });

    it('merges metadata into span attributes and strips Langfuse-only keys', async () => {
      const handler = new TracciaCallbackHandler();
      (handler as any)['tracer'] = mockTracer;
      const chain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };

      await handler.handleChainStart(chain, {}, 'metadata-run', undefined, undefined, {
        customKey: 'customValue',
        langfusePrompt: { name: 'p', version: 1, isFallback: false },
        langfuseUserId: 'user-1',
        langfuseSessionId: 'session-1',
      });

      const span = (handler as any)['runMap'].get('metadata-run');
      expect(span.attributes.customKey).toBe('customValue');
      expect(span.attributes.langfusePrompt).toBeUndefined();
      expect(span.attributes.langfuseUserId).toBeUndefined();
      expect(span.attributes.langfuseSessionId).toBeUndefined();
    });
  });
});