/**
 * Tests for LangGraph integration
 */

import {
  instrumentLangGraph,
  createTracedNode,
  createTracedConditional,
} from '../integrations/langgraph-instrumentation';
import { startTracing, stopTracing } from '../auto';

describe('LangGraph Integration', () => {
  beforeEach(() => {
    startTracing({
      enableTokenCounting: false,
      enableCostTracking: false,
    });
  });

  afterEach(() => {
    stopTracing();
  });

  describe('instrumentLangGraph', () => {
    it('should instrument a graph and override compile', () => {
      const mockGraph = {
        graph_name: 'test-graph',
        compile: jest.fn(() => ({
          invoke: jest.fn(),
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph, { graphName: 'custom-graph' });

      expect(instrumented).toBeDefined();
      expect(instrumented.compile).toBeDefined();
    });

    it('should use provided graph name', () => {
      const mockGraph = {
        compile: jest.fn(() => ({
          invoke: jest.fn(),
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph, { graphName: 'my-agent' });
      expect(instrumented).toBeDefined();
    });

    it('should use graph_name if no option provided', () => {
      const mockGraph = {
        graph_name: 'default-graph',
        compile: jest.fn(() => ({
          invoke: jest.fn(),
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph);
      expect(instrumented).toBeDefined();
    });

    it('should wrap invoke method', async () => {
      const mockInvoke = jest.fn(async () => ({ result: 'success' }));
      const mockGraph = {
        compile: jest.fn(() => ({
          invoke: mockInvoke,
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph);
      const compiled = instrumented.compile();

      expect(compiled.invoke).toBeDefined();
      expect(typeof compiled.invoke).toBe('function');
    });

    it('should invoke original compile and invoke', async () => {
      const mockInvoke = jest.fn(async () => ({ result: 'success' }));
      const mockCompile = jest.fn(() => ({
        invoke: mockInvoke,
      }));

      const mockGraph = { compile: mockCompile };

      const instrumented = instrumentLangGraph(mockGraph);
      const compiled = instrumented.compile();

      await compiled.invoke({ test: 'input' });

      expect(mockCompile).toHaveBeenCalled();
      expect(mockInvoke).toHaveBeenCalled();
    });

    it('should pass through invoke result', async () => {
      const expectedResult = { messages: [{ content: 'response' }] };
      const mockInvoke = jest.fn(async () => expectedResult);

      const mockGraph = {
        compile: jest.fn(() => ({
          invoke: mockInvoke,
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph);
      const compiled = instrumented.compile();
      const result = await compiled.invoke({ input: 'test' });

      expect(result).toEqual(expectedResult);
    });

    it('should handle invoke errors', async () => {
      const testError = new Error('Invoke failed');
      const mockInvoke = jest.fn(async () => {
        throw testError;
      });

      const mockGraph = {
        compile: jest.fn(() => ({
          invoke: mockInvoke,
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph);
      const compiled = instrumented.compile();

      await expect(compiled.invoke({ input: 'test' })).rejects.toThrow('Invoke failed');
    });

    it('should wrap stream method if available', async () => {
      const mockStream = jest.fn(async function* () {
        yield { node: 'agent', data: { step: 1 } };
      });

      const mockGraph = {
        compile: jest.fn(() => ({
          invoke: jest.fn(),
          stream: mockStream,
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph);
      const compiled = instrumented.compile();

      expect(compiled.stream).toBeDefined();
    });

    it('should handle stream with thread_id config', async () => {
      const mockStream = jest.fn(async function* () {
        yield { node: 'agent' };
      });

      const mockGraph = {
        compile: jest.fn(() => ({
          invoke: jest.fn(),
          stream: mockStream,
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph);
      const compiled = instrumented.compile();

      const config = { configurable: { thread_id: 'thread-123' } };

      // Consume the async generator
      let eventCount = 0;
      for await (const _event of compiled.stream({ input: 'test' }, config)) {
        eventCount++;
      }

      expect(mockStream).toHaveBeenCalledWith({ input: 'test' }, config);
      expect(eventCount).toBe(1);
    });

    it('should count stream events', async () => {
      const mockStream = jest.fn(async function* () {
        yield { event: 1 };
        yield { event: 2 };
        yield { event: 3 };
      });

      const mockGraph = {
        compile: jest.fn(() => ({
          invoke: jest.fn(),
          stream: mockStream,
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph);
      const compiled = instrumented.compile();

      let eventCount = 0;
      for await (const _event of compiled.stream({ input: 'test' })) {
        eventCount++;
      }

      expect(eventCount).toBe(3);
    });

    it('should handle stream errors', async () => {
      const testError = new Error('Stream failed');
      const mockStream = jest.fn(async function* () {
        throw testError;
      });

      const mockGraph = {
        compile: jest.fn(() => ({
          invoke: jest.fn(),
          stream: mockStream,
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph);
      const compiled = instrumented.compile();

      await expect(async () => {
        for await (const _event of compiled.stream({ input: 'test' })) {
          // Consume stream
        }
      }).rejects.toThrow('Stream failed');
    });
  });

  describe('createTracedNode', () => {
    it('should create a wrapped node function', () => {
      const nodeFunc = jest.fn(async (_state) => ({ result: 'ok' }));
      const tracedNode = createTracedNode('test-node', nodeFunc);

      expect(typeof tracedNode).toBe('function');
    });

    it('should execute the original node function', async () => {
      const nodeFunc = jest.fn(async (state) => ({ updated: state.count + 1 }));
      const tracedNode = createTracedNode('counter', nodeFunc);

      const state = { count: 5 };
      const result = await tracedNode(state);

      expect(nodeFunc).toHaveBeenCalledWith(state);
      expect(result).toEqual({ updated: 6 });
    });

    it('should pass through node output', async () => {
      const expectedOutput = { messages: [{ role: 'assistant', content: 'response' }] };
      const nodeFunc = jest.fn(async () => expectedOutput);

      const tracedNode = createTracedNode('agent', nodeFunc);
      const result = await tracedNode({ input: 'test' });

      expect(result).toEqual(expectedOutput);
    });

    it('should handle node function errors', async () => {
      const nodeError = new Error('Node execution failed');
      const nodeFunc = jest.fn(async () => {
        throw nodeError;
      });

      const tracedNode = createTracedNode('failing-node', nodeFunc);

      await expect(tracedNode({ data: 'test' })).rejects.toThrow('Node execution failed');
    });

    it('should support multiple traced nodes', async () => {
      const agentFunc = jest.fn(async (state) => ({ ...state, agent_output: 'response' }));
      const toolsFunc = jest.fn(async (state) => ({ ...state, tools_output: 'tool-result' }));

      const agentNode = createTracedNode('agent', agentFunc);
      const toolsNode = createTracedNode('tools', toolsFunc);

      const state = { messages: [] };
      const result1 = await agentNode(state);
      const result2 = await toolsNode(result1);

      expect(result2).toHaveProperty('agent_output');
      expect(result2).toHaveProperty('tools_output');
    });

    it('should handle async node functions', async () => {
      const asyncNode = jest.fn(async (_state) => {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ delayed: true }), 10)
        );
      });

      const tracedNode = createTracedNode('async-node', asyncNode);
      const result = await tracedNode({ input: 'test' });

      expect(result).toEqual({ delayed: true });
    });
  });

  describe('createTracedConditional', () => {
    it('should create a wrapped conditional function', () => {
      const conditionalFunc = jest.fn((_state) => 'next-node');
      const tracedConditional = createTracedConditional('router', conditionalFunc);

      expect(typeof tracedConditional).toBe('function');
    });

    it('should execute conditional logic and return route', () => {
      const conditionalFunc = jest.fn((state) => {
        return state.continue ? 'continue' : 'end';
      });

      const tracedConditional = createTracedConditional('should-continue', conditionalFunc);

      const result1 = tracedConditional({ continue: true });
      const result2 = tracedConditional({ continue: false });

      expect(result1).toBe('continue');
      expect(result2).toBe('end');
    });

    it('should pass through conditional result', () => {
      const route = 'tool-executor';
      const conditionalFunc = jest.fn(() => route);

      const tracedConditional = createTracedConditional('route', conditionalFunc);
      const result = tracedConditional({ decision_data: 'test' });

      expect(result).toBe(route);
    });

    it('should handle conditional errors', () => {
      const conditionError = new Error('Routing failed');
      const conditionalFunc = jest.fn(() => {
        throw conditionError;
      });

      const tracedConditional = createTracedConditional('failing-route', conditionalFunc);

      expect(() => tracedConditional({ data: 'test' })).toThrow('Routing failed');
    });

    it('should support complex routing logic', () => {
      const conditionalFunc = jest.fn((state) => {
        if (state.messages.length > 10) return 'end';
        if (state.needs_tool) return 'tools';
        return 'llm';
      });

      const tracedConditional = createTracedConditional('complex-route', conditionalFunc);

      expect(tracedConditional({ messages: [], needs_tool: true })).toBe('tools');
      expect(tracedConditional({ messages: [], needs_tool: false })).toBe('llm');
      expect(tracedConditional({ messages: Array(15) })).toBe('end');
    });

    it('should handle different route values', () => {
      const conditionalFunc = jest.fn((state) => {
        const routes = ['node-a', 'node-b', 'node-c', 'end'];
        return routes[state.selector % routes.length];
      });

      const tracedConditional = createTracedConditional('multi-route', conditionalFunc);

      expect(tracedConditional({ selector: 0 })).toBe('node-a');
      expect(tracedConditional({ selector: 1 })).toBe('node-b');
      expect(tracedConditional({ selector: 2 })).toBe('node-c');
      expect(tracedConditional({ selector: 3 })).toBe('end');
    });
  });

  describe('Integration Scenarios', () => {
    it('should support full graph instrumentation flow', async () => {
      const agentNode = jest.fn(async (state) => ({ ...state, agent_done: true }));
      const toolsNode = jest.fn(async (state) => ({ ...state, tools_done: true }));

      const conditionalFunc = jest.fn((state) => (state.agent_done ? 'tools' : 'agent'));

      const tracedAgent = createTracedNode('agent', agentNode);
      const tracedTools = createTracedNode('tools', toolsNode);
      const tracedRoute = createTracedConditional('route', conditionalFunc);

      const mockGraph = {
        compile: jest.fn(() => ({
          invoke: jest.fn(),
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph);

      // Verify all tracing functions work together
      expect(tracedAgent).toBeDefined();
      expect(tracedTools).toBeDefined();
      expect(tracedRoute).toBeDefined();
      expect(instrumented).toBeDefined();
    });

    it('should handle state flowing through traced nodes', async () => {
      const state1 = { count: 1, steps: ['start'] };

      const _nodeA = createTracedNode('node-a', async (s) => ({
        ...s,
        count: s.count + 1,
        steps: [...s.steps, 'a'],
      }));

      const _nodeB = createTracedNode('node-b', async (s) => ({
        ...s,
        count: s.count * 2,
        steps: [...s.steps, 'b'],
      }));

      const result = await _nodeB(await _nodeA(state1));

      expect(result.count).toBe(4); // (1+1)*2
      expect(result.steps).toEqual(['start', 'a', 'b']);
    });

    it('should handle conditional routing between traced nodes', async () => {
      const router = createTracedConditional('route', (state) => {
        return state.go_to_b ? 'b' : 'a';
      });

      const initialState = { data: 'test' };

      const route1 = router(initialState);
      const route2 = router({ ...initialState, go_to_b: true });

      expect(route1).toBe('a');
      expect(route2).toBe('b');
    });
  });

  describe('Edge Cases', () => {
    it('should handle null state in traced node', async () => {
      const nodeFunc = jest.fn(async (state) => state || {});
      const tracedNode = createTracedNode('nullable-node', nodeFunc);

      const result = await tracedNode(null);
      expect(result).toBeDefined();
    });

    it('should handle empty graph name', () => {
      const mockGraph = {
        compile: jest.fn(() => ({ invoke: jest.fn() })),
      };

      const instrumented = instrumentLangGraph(mockGraph, { graphName: '' });
      expect(instrumented).toBeDefined();
    });

    it('should handle graph without stream method', async () => {
      const mockGraph = {
        compile: jest.fn(() => ({
          invoke: jest.fn(async () => ({ result: 'ok' })),
          // No stream method
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph);
      const compiled = instrumented.compile();

      expect(compiled.invoke).toBeDefined();
      expect(compiled.stream).toBeUndefined();
    });

    it('should handle undefined config in stream', async () => {
      const mockStream = jest.fn(async function* () {
        yield { data: 'test' };
      });

      const mockGraph = {
        compile: jest.fn(() => ({
          invoke: jest.fn(),
          stream: mockStream,
        })),
      };

      const instrumented = instrumentLangGraph(mockGraph);
      const compiled = instrumented.compile();

      for await (const event of compiled.stream({ input: 'test' })) {
        expect(event).toBeDefined();
      }
    });
  });
});
