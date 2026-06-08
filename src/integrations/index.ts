/**
 * Traccia SDK Integrations
 * Provides automatic instrumentation for popular frameworks and libraries.
 *
 * @module integrations
 */

// LangChain integrations
export { TracciaCallbackHandler } from './langchain-callback';
export { TracciaCallbackHandlerOld } from './langchain-callback.old';
export {
  getTraciaHandler,
  withTracing,
  createTracedOpenAI,
  createTracedAgentExecutor,
  createTracedLLMChain,
  traced,
  setupLangChainWithTracing,
} from './auto-langchain';

// LangGraph integrations
export {
  instrumentLangGraph,
  createTracedNode,
  createTracedConditional,
} from './langgraph-instrumentation';
export {
  wrapGraphWithTracing,
  tracedNode,
  tracedConditional,
  createSimpleTracedGraph,
  traceableFunction,
  createAgentWorkflow,
} from './auto-langgraph';

// Ollama integrations
export {
  createOllamaWithTracing,
  setupOllamaWithTracing,
  createOllamaChatbot,
  createOllamaStreamingChatbot,
  getOllamaSetupInstructions,
  POPULAR_OLLAMA_MODELS,
} from './ollama-integration';

// OpenAI Agents SDK integration
export { install as installOpenAIAgents } from './openai-agents';

// CrewAI integration
export { install as installCrewai } from './crewai';
