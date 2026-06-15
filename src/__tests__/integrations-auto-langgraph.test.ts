import {
  wrapGraphWithTracing,
  tracedNode,
  tracedConditional,
  createSimpleTracedGraph,
  traceableFunction,
  createAgentWorkflow,
} from '../integrations/auto-langgraph';

// Mock dependencies
jest.mock('../integrations/langgraph-instrumentation', () => ({
  instrumentLangGraph: jest.fn().mockImplementation((graph) => ({ _mock: 'instrumented_graph', graph })),
  createTracedNode: jest.fn().mockImplementation((name, fn) => {
    const wrapper = async (state: any) => await fn(state);
    wrapper._mockName = name;
    return wrapper;
  }),
  createTracedConditional: jest.fn().mockImplementation((name, fn) => {
    const wrapper = (state: any) => fn(state);
    wrapper._mockName = name;
    return wrapper;
  }),
}));

const mockGraphInstance = {
  addNode: jest.fn(),
  addEdge: jest.fn(),
  setEntryPoint: jest.fn(),
  setFinishPoint: jest.fn(),
  addConditionalEdges: jest.fn(),
};

jest.mock('@langchain/langgraph', () => ({
  StateGraph: jest.fn().mockImplementation(() => mockGraphInstance),
}), { virtual: true });

jest.mock('../auto', () => ({
  getTracer: jest.fn().mockReturnValue({
    startActiveSpan: jest.fn().mockImplementation(async (name, fn) => {
      const mockSpan = {
        setAttribute: jest.fn(),
        recordException: jest.fn(),
      };
      return await fn(mockSpan);
    }),
  }),
}));

describe('auto-langgraph', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('wrapGraphWithTracing', () => {
    it('should wrap a graph with default options', () => {
      const graph = { name: 'my-graph' };
      const result = wrapGraphWithTracing(graph);
      expect(result._mock).toBe('instrumented_graph');
      expect(result.graph).toBe(graph);
    });

    it('should pass options to instrumentLangGraph', () => {
      const graph = { name: 'my-graph' };
      wrapGraphWithTracing(graph, { captureState: true, customOpt: 'test' });
      const instrumentationModule = require('../integrations/langgraph-instrumentation');
      expect(instrumentationModule.instrumentLangGraph).toHaveBeenCalledWith(
        graph,
        expect.objectContaining({
          traceGraphExecution: true,
          traceNodeExecution: true,
          captureGraphState: true,
          customOpt: 'test'
        })
      );
    });
  });

  describe('tracedNode', () => {
    it('should create a traced node', () => {
      const mockFn = jest.fn();
      const result = tracedNode('my-node', mockFn);
      expect((result as any)._mockName).toBe('my-node');
    });
  });

  describe('tracedConditional', () => {
    it('should create a traced conditional', () => {
      const mockFn = jest.fn();
      const result = tracedConditional('my-cond', mockFn);
      expect((result as any)._mockName).toBe('my-cond');
    });
  });

  describe('createSimpleTracedGraph', () => {
    it('should construct and return a traced graph', async () => {
      const options = {
        nodes: {
          nodeA: jest.fn(),
          nodeB: jest.fn(),
        },
        edges: [
          { from: '__start__', to: 'nodeA' },
          { from: 'nodeA', to: 'nodeB' },
          { from: 'nodeB', to: '__end__' },
        ],
        conditionals: {
          myRouter: { router: jest.fn(), routes: ['route1', 'route2'] }
        }
      };

      const result = await createSimpleTracedGraph(options);
      
      expect(result._mock).toBe('instrumented_graph');
      expect(mockGraphInstance.addNode).toHaveBeenCalledTimes(2);
      expect(mockGraphInstance.setEntryPoint).toHaveBeenCalledWith('nodeA');
      expect(mockGraphInstance.addEdge).toHaveBeenCalledWith('nodeA', 'nodeB');
      expect(mockGraphInstance.setFinishPoint).toHaveBeenCalledWith('nodeB');
      expect(mockGraphInstance.addConditionalEdges).toHaveBeenCalledWith(
        'myRouter',
        expect.any(Function),
        ['route1', 'route2']
      );
    });
  });

  describe('traceableFunction', () => {
    it('should wrap a function in a span', async () => {
      const fn = jest.fn().mockResolvedValue({ status: 'ok' });
      const tracedFn = traceableFunction('my-span', fn);
      
      const result = await tracedFn({ input: 'test' });
      
      expect(result).toEqual({ status: 'ok' });
      expect(fn).toHaveBeenCalledWith({ input: 'test' });
    });

    it('should record exceptions', async () => {
      const error = new Error('test error');
      const fn = jest.fn().mockRejectedValue(error);
      const tracedFn = traceableFunction('my-span', fn);
      
      await expect(tracedFn({ input: 'test' })).rejects.toThrow('test error');
    });
  });

  describe('createAgentWorkflow', () => {
    it('should build an agent workflow graph', async () => {
      const options = {
        processInput: jest.fn(),
        routeDecision: jest.fn().mockReturnValue('done'),
      };

      const result = await createAgentWorkflow(options);
      expect(result._mock).toBe('instrumented_graph');
      // process node
      expect(mockGraphInstance.addNode).toHaveBeenCalledWith('process', expect.any(Function));
    });
    
    it('should include review and final steps if provided', async () => {
      const options = {
        processInput: jest.fn(),
        routeDecision: jest.fn().mockReturnValue('review'),
        reviewStep: jest.fn(),
        finalStep: jest.fn(),
      };

      await createAgentWorkflow(options);
      expect(mockGraphInstance.addNode).toHaveBeenCalledWith('review', expect.any(Function));
      expect(mockGraphInstance.addNode).toHaveBeenCalledWith('final', expect.any(Function));
    });
  });
});
