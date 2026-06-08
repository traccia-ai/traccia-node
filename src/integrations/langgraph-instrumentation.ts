/**
 * LangGraph instrumentation for automatic tracing.
 * Provides utilities to instrument LangGraph state graphs for automatic tracing.
 */

import { getTracer } from '../auto';

/**
 * Instrument a LangGraph to automatically trace execution.
 * Wraps graph invocation to create spans for the entire graph execution.
 *
 * @example
 * import { StateGraph } from 'langchain/graph';
 * import { instrumentLangGraph } from '@traccia/sdk/integrations/langgraph';
 *
 * const graph = new StateGraph(AgentState)
 *   .addNode('agent', agentNode)
 *   .addNode('tools', toolsNode)
 *   .addEdge('agent', 'tools')
 *   .addEdge('tools', 'agent');
 *
 * const instrumented = instrumentLangGraph(graph, { graphName: 'my-agent' });
 * const compiled = instrumented.compile();
 *
 * await compiled.invoke({ messages: [...] });
 * // Automatically traced with span for graph execution
 */
export function instrumentLangGraph(graph: any, options?: { graphName?: string }): any {
  const tracer = getTracer('langgraph');
  const graphName = options?.graphName || graph.graph_name || 'langgraph';

  // Store original compile method
  const originalCompile = graph.compile.bind(graph);

  // Override compile to wrap invocation
  graph.compile = function() {
    const compiled = originalCompile();
    const originalInvoke = compiled.invoke.bind(compiled);
    const originalStream = compiled.stream?.bind(compiled);

    /**
     * Wrap invoke calls with tracing.
     */
    compiled.invoke = async function(input: any, config?: any) {
      const span = tracer.startSpan('langgraph-invoke', {
        attributes: {
          graph_name: graphName,
          config_thread_id: config?.configurable?.thread_id,
        },
      });

      try {
        const result = await originalInvoke(input, config);
        span.end();
        return result;
      } catch (error) {
        span.recordException(error as Error, { context: 'langgraph-invoke' });
        span.end();
        throw error;
      }
    };

    /**
     * Wrap stream calls with tracing.
     */
    if (originalStream) {
      compiled.stream = async function*(input: any, config?: any) {
        const span = tracer.startSpan('langgraph-stream', {
          attributes: {
            graph_name: graphName,
            config_thread_id: config?.configurable?.thread_id,
          },
        });

        let eventCount = 0;
        try {
          for await (const event of originalStream(input, config)) {
            eventCount++;
            yield event;
          }
          span.setAttribute('stream_events', eventCount);
          span.end();
        } catch (error) {
          span.recordException(error as Error, { context: 'langgraph-stream' });
          span.setAttribute('stream_events', eventCount);
          span.end();
          throw error;
        }
      };
    }

    return compiled;
  };

  return graph;
}

/**
 * Create a traced node function wrapper for LangGraph nodes.
 * Automatically wraps node execution with tracing spans.
 *
 * @example
 * import { createTracedNode } from '@traccia/sdk/integrations/langgraph';
 *
 * const agentNode = createTracedNode('agent', async (state) => {
 *   // Your agent logic here
 *   return { messages: [...] };
 * });
 *
 * graph.addNode('agent', agentNode);
 */
export function createTracedNode(
  nodeName: string,
  nodeFunc: (state: any) => Promise<any>
): (state: any) => Promise<any> {
  const tracer = getTracer('langgraph');

  return async function tracedNode(state: any) {
    const span = tracer.startSpan(`node:${nodeName}`, {
      attributes: {
        node_name: nodeName,
      },
    });

    try {
      const result = await nodeFunc(state);
      span.end();
      return result;
    } catch (error) {
      span.recordException(error as Error, { node: nodeName });
      span.end();
      throw error;
    }
  };
}

/**
 * Create a traced conditional edge function for LangGraph.
 * Wraps conditional routing logic with tracing.
 *
 * @example
 * import { createTracedConditional } from '@traccia/sdk/integrations/langgraph';
 *
 * const shouldContinue = createTracedConditional('should_continue', (state) => {
 *   return state.messages.length > 10 ? 'end' : 'continue';
 * });
 *
 * graph.addConditionalEdges('agent', shouldContinue);
 */
export function createTracedConditional(
  conditionName: string,
  conditionFunc: (state: any) => string
): (state: any) => string {
  const tracer = getTracer('langgraph');

  return function tracedConditional(state: any) {
    const span = tracer.startSpan(`condition:${conditionName}`, {
      attributes: {
        condition_name: conditionName,
      },
    });

    try {
      const result = conditionFunc(state);
      span.setAttribute('condition_result', result);
      span.end();
      return result;
    } catch (error) {
      span.recordException(error as Error, { condition: conditionName });
      span.end();
      throw error;
    }
  };
}
