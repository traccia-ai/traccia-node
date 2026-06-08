/**
 * Instrumentation module exports.
 *
 * This module provides auto-instrumentation for various libraries and frameworks.
 */

// LLM Client Instrumentation
export { patchOpenAI, wrapOpenAICreate, patchOpenAIResponses, wrapOpenAIResponsesCreate } from './openai';
export { patchAnthropic, wrapAnthropicCreate } from './anthropic';

// HTTP Client Instrumentation
export { patchAxios, createTracedAxios } from './axios';
export { patchFetch, unpatchFetch, createTracedFetch } from './fetch';

// Framework Middleware
export { expressMiddleware, expressErrorMiddleware } from './express';
export type { TracingMiddlewareOptions } from './express';
export { fastifyPlugin, fastifyPluginAsync } from './fastify';
export type { FastifyTracingOptions } from './fastify';
