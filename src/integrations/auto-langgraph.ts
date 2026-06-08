/**
 * Automatic LangGraph instrumentation - simple one-line setup.
 * 
 * Wrap your LangGraph nodes and conditionals to get tracing without
 * any boilerplate code.
 */

import {
  instrumentLangGraph,
  createTracedNode,
  createTracedConditional,
} from './langgraph-instrumentation';

/**
 * Wrap a StateGraph with automatic tracing.
 * 
 * @example
 * const graph = new StateGraph(GraphState);
 * graph.addNode('step1', processStep1);
 * graph.addNode('step2', processStep2);
 * graph.addEdge('step1', 'step2');
 * 
 * // Just wrap your graph!
 * const traced = wrapGraphWithTracing(graph);
 * const compiled = traced.compile();
 * 
 * const result = await compiled.invoke({ input: 'data' });
 * // Fully traced with no other changes!
 */
export function wrapGraphWithTracing(graph: any, options: any = {}): any {
  return instrumentLangGraph(graph, {
    traceGraphExecution: true,
    traceNodeExecution: true,
    captureGraphState: options.captureState ?? false,
    ...options,
  });
}

/**
 * Create a traced node function with one line.
 * 
 * @example
 * // Wrap your existing node:
 * const existingNode = (state) => ({ result: 'done' });
 * const traced = tracedNode('process-step', existingNode);
 * graph.addNode('process', traced);
 */
export function tracedNode(
  nodeName: string,
  nodeFunction: (state: any) => Promise<any> | any
): (state: any) => Promise<any> {
  return createTracedNode(nodeName, nodeFunction);
}

/**
 * Create a traced conditional edge router with one line.
 * 
 * @example
 * // Wrap your existing router:
 * const decideRoute = (state) => state.approved ? 'done' : 'review';
 * const traced = tracedConditional('route-check', decideRoute);
 * graph.addConditionalEdges('check', traced);
 */
export function tracedConditional(
  conditionalName: string,
  routeFunction: (state: Record<string, any>) => string
): (state: Record<string, any>) => string {
  return createTracedConditional(conditionalName, routeFunction);
}

/**
 * Factory function to create a traced agent graph from simple config.
 * 
 * @example
 * const graph = createSimpleTracedGraph({
 *   nodes: {
 *     'process': async (state) => ({ result: await process(state.input) }),
 *     'review': async (state) => ({ reviewed: true }),
 *   },
 *   edges: [
 *     { from: '__start__', to: 'process' },
 *     { from: 'process', to: 'review' },
 *     { from: 'review', to: '__end__' },
 *   ],
 * });
 * 
 * const result = await graph.compile().invoke({ input: 'data' });
 */
export async function createSimpleTracedGraph(options: {
  nodes: Record<string, (state: any) => Promise<any>>;
  edges: Array<{ from: string; to: string }>;
  conditionals?: Record<
    string,
    { router: (state: any) => string; routes: string[] }
  >;
  startState?: Record<string, any>;
}): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const langgraphModule = require('@langchain/langgraph');
    const { nodes, edges, conditionals = {}, startState = {} } = options;

    // Create state graph
    const graph = new langgraphModule.StateGraph({
      channels: startState,
    });

    // Add traced nodes
    for (const [nodeName, nodeFunc] of Object.entries(nodes)) {
      const tracedNodeFunc = tracedNode(nodeName, nodeFunc);
      graph.addNode(nodeName, tracedNodeFunc);
    }

    // Add edges
    for (const edge of edges) {
      if (edge.from === '__start__') {
        graph.setEntryPoint(edge.to);
      } else if (edge.to === '__end__') {
        graph.setFinishPoint(edge.from);
      } else {
        graph.addEdge(edge.from, edge.to);
      }
    }

    // Add conditional edges
    for (const [condName, condConfig] of Object.entries(conditionals)) {
      const tracedRouter = tracedConditional(condName, condConfig.router);
      graph.addConditionalEdges(condName, tracedRouter, condConfig.routes);
    }

    // Wrap entire graph with tracing
    return wrapGraphWithTracing(graph);
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Failed to create simple traced graph: ${err.message}. Make sure @langchain/langgraph is installed.`
    );
  }
}

/**
 * Trace a single agent function or tool with minimal setup.
 * 
 * @example
 * const tool = traceableFunction('my-tool', async (input) => {
 *   return processInput(input);
 * });
 * 
 * const result = await tool('data');
 * // Automatically traced!
 */
export function traceableFunction<T extends (...args: any[]) => any>(
  spanName: string,
  fn: T
): T {
  return (async (...args: any[]) => {
    const { getTracer } = await import('../auto');
    const tracer = getTracer('traceable-function');

    return tracer.startActiveSpan(spanName, async (span) => {
      try {
        span.setAttribute('args_count', args.length);
        if (args[0] && typeof args[0] === 'object') {
          span.setAttribute('input_keys', Object.keys(args[0]).join(','));
        }

        const result = await fn(...args);

        if (result && typeof result === 'object') {
          span.setAttribute('output_keys', Object.keys(result).join(','));
        }
        span.setAttribute('success', true);

        return result;
      } catch (error) {
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      }
    });
  }) as T;
}

/**
 * Quick setup for a common agent pattern: input → process → route → output.
 * 
 * @example
 * const graph = await createAgentWorkflow({
 *   processInput: async (state) => ({ processed: await analyze(state.input) }),
 *   routeDecision: (state) => state.processed.needsReview ? 'review' : 'done',
 *   reviewStep: async (state) => ({ reviewed: true }),
 * });
 * 
 * const result = await graph.compile().invoke({ input: 'user input' });
 */
export async function createAgentWorkflow(options: {
  processInput: (state: Record<string, any>) => Promise<Record<string, any>>;
  routeDecision: (state: Record<string, any>) => string;
  reviewStep?: (state: Record<string, any>) => Promise<Record<string, any>>;
  finalStep?: (state: Record<string, any>) => Promise<Record<string, any>>;
}): Promise<any> {
  try {
    const {
      processInput,
      routeDecision,
      reviewStep,
      finalStep,
    } = options;

    const nodes: Record<string, (state: any) => Promise<any>> = {
      process: processInput,
    };

    if (reviewStep) nodes.review = reviewStep;
    if (finalStep) nodes.final = finalStep;

    const edges: Array<{ from: string; to: string }> = [
      { from: '__start__', to: 'process' },
    ];

    const conditionals: Record<string, any> = {
      route: {
        router: routeDecision,
        routes: ['done', ...(reviewStep ? ['review'] : [])],
      },
    };

    edges.push({ from: 'process', to: 'route' });

    if (reviewStep) {
      edges.push({ from: 'review', to: finalStep ? 'final' : '__end__' });
    }

    if (finalStep) {
      edges.push({ from: 'final', to: '__end__' });
    }

    return createSimpleTracedGraph({
      nodes,
      edges,
      conditionals,
    });
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to create agent workflow: ${err.message}`);
  }
}
