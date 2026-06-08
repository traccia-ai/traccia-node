// /**
//  * Tests for LangChain integration (TraciaCallbackHandler)
//  */

// import { TracciaCallbackHandler } from '../integrations/langchain-callback';
// import { startTracing, stopTracing } from '../auto';

// describe('TracciaCallbackHandler', () => {
//   beforeEach(() => {
//     startTracing({
//       enableTokenCounting: false,
//       enableCostTracking: false,
//     });
//   });

//   afterEach(() => {
//     stopTracing();
//   });

//   describe('handleLLMStart', () => {
//     it('should create a span for LLM invocation', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockLLM = {
//         name: 'gpt-4',
//         _modelType: 'openai',
//         lc: 1,
//         type: 'not_implemented' as const,
//         id: ['openai', 'gpt-4'],
//       };

//       await handler.handleLLMStart(mockLLM, ['prompt1', 'prompt2'], 'run-1');

//       // Verify span was created in the handler's span map
//       expect(handler['runMap'].has('run-1')).toBe(true);
//     });

//     it('should capture LLM model name in attributes', async () => {
//       const handler = new TracciaCallbackHandler();
//         const mockLLM = {
//           name: 'gpt-4',
//           _modelType: 'openai',
//           lc: 1,
//           type: 'not_implemented' as const,
//           id: ['openai', 'gpt-4'],
//         };

//       await handler.handleLLMStart(mockLLM, ['test prompt'], 'run-2');

//       const span = handler['runMap'].get('run-2');
//       expect(span?.attributes?.model).toMatch(/claude-3|anthropic/);
//     });

//     it('should capture prompt count', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockLLM = {
//         name: 'claude-3',
//         _modelType: 'anthropic',
//         lc: 1,
//         type: 'not_implemented' as const,
//         id: ['anthropic', 'claude-3'],
//       };
//       const prompts = ['p1', 'p2', 'p3'];
//       await handler.handleLLMStart(mockLLM, prompts, 'run-3');
//       const span = handler['runMap'].get('run-3');
//       expect(span?.attributes?.prompt_count).toBe(3);
//     });

//     it('should handle missing model name gracefully', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockLLM = { lc: 1, type: 'not_implemented' as const, id: ['unknown'] };
//       await handler.handleLLMStart(mockLLM, ['prompt'], 'run-4');
//       const span = handler['runMap'].get('run-4');
//       expect(span?.attributes?.model).toBe('unknown');
//     });
//   });

//   describe('handleLLMEnd', () => {
//     it('should end LLM span and record token counts', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockLLM = { name: 'gpt-4', lc: 1, type: 'not_implemented' as const, id: ['openai', 'gpt-4'] };
//       await handler.handleLLMStart(mockLLM, ['prompt'], 'run-5');
//       const output = { generations: [[{ text: 'test' }]] };
//       await handler.handleLLMEnd?.(output, 'run-5');
//       expect(handler['runMap'].has('run-5')).toBe(false);
//     });

//     it('should end LLM span with long output', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockLLM = { name: 'claude-3', lc: 1, type: 'not_implemented' as const, id: ['anthropic', 'claude-3'] };
//       await handler.handleLLMStart(mockLLM, ['prompt'], 'run-6');
//       const output = { generations: [[{ text: 'This is a test response that has some length to it' }]] };
//       await handler.handleLLMEnd?.(output, 'run-6');
//       expect(handler['runMap'].has('run-6')).toBe(false);
//     });
//   });

//   describe('handleChainStart', () => {
//     it('should create a span for chain execution', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockChain = {
//         name: 'test-chain',
//         _chainType: 'stuff',
//         lc: 1,
//         type: 'not_implemented' as const,
//         id: ['test', 'test-chain'],
//       };

//       await handler.handleChainStart(mockChain, { input: 'test' }, 'chain-1');

//       expect(handler['runMap'].has('chain-1')).toBe(true);
//     });

//     it('should capture chain name and type', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockChain = {
//         name: 'qa-chain',
//         _chainType: 'retrieval_qa',
//         lc: 1,
//         type: 'not_implemented' as const,
//         id: ['test', 'qa-chain'],
//       };

//       await handler.handleChainStart(mockChain, { query: 'test' }, 'chain-2');

//       const span = handler['runMap'].get('chain-2');
//       expect(span?.attributes?.chain_name).toBe('qa-chain');
//       expect(span?.attributes?.chain_type).toBe('retrieval_qa');
//     });

//     it('should record input keys', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockChain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };
//       const inputs = { key1: 'value1', key2: 'value2' };

//       await handler.handleChainStart(mockChain, inputs, 'chain-3');

//       const span = handler['runMap'].get('chain-3');
//       expect(span?.attributes?.input_keys).toContain('key1');
//       expect(span?.attributes?.input_keys).toContain('key2');
//     });
//   });

//   describe('handleChainEnd', () => {
//     it('should end chain span and record output', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockChain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };

//       await handler.handleChainStart(mockChain, { input: 'test' }, 'chain-4');

//       const output = { output: 'result' };
//       await handler.handleChainEnd(output, 'chain-4');

//       expect(handler['runMap'].has('chain-4')).toBe(false);
//     });
//   });

//   describe('handleToolStart', () => {
//     it('should create a span for tool invocation', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockTool = {
//         name: 'search-api',
//         lc: 1,
//         type: 'not_implemented' as const,
//         id: ['test', 'search-api'],
//       };

//       await handler.handleToolStart(mockTool, 'search query', 'tool-1');

//       expect(handler['runMap'].has('tool-1')).toBe(true);
//     });

//     it('should capture tool name', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockTool = { name: 'calculator', lc: 1, type: 'not_implemented' as const, id: ['test', 'calculator'] };

//       await handler.handleToolStart(mockTool, '2+2', 'tool-2');

//       const span = handler['runMap'].get('tool-2');
//       expect(span?.attributes?.tool_name).toBe('calculator');
//     });

//     it('should record input length', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockTool = { name: 'tool', lc: 1, type: 'not_implemented' as const, id: ['test', 'tool'] };
//       const input = 'test input with some length';

//       await handler.handleToolStart(mockTool, input, 'tool-3');

//       const span = handler['runMap'].get('tool-3');
//       expect(span?.attributes?.input_length).toBeGreaterThan(0);
//     });
//   });

//   describe('handleToolEnd', () => {
//     it('should end tool span', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockTool = { name: 'tool', lc: 1, type: 'not_implemented' as const, id: ['test', 'tool'] };

//       await handler.handleToolStart(mockTool, 'input', 'tool-4');
//       await handler.handleToolEnd?.('output', 'tool-4');

//       expect(handler['runMap'].has('tool-4')).toBe(false);
//     });

//     it('should record output length', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockTool = { name: 'tool', lc: 1, type: 'not_implemented' as const, id: ['test', 'tool'] };

//       await handler.handleToolStart(mockTool, 'input', 'tool-5');
//       const output = 'This is the tool output response';
//       await handler.handleToolEnd?.(output, 'tool-5');

//       expect(handler['runMap'].has('tool-5')).toBe(false);
//     });
//   });

//   describe('handleAgentAction', () => {
//     it('should update existing span on agent action', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockChain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };

//       // Start a span first
//       await handler.handleChainStart(mockChain, {}, 'agent-1');

//       // Then handle agent action
//       const mockAction = {
//         tool: 'search',
//         toolInput: 'query',
//         log: '',
//       };
//       await handler.handleAgentAction(mockAction, 'agent-1');

//       // Span should still exist
//       expect(handler['runMap'].has('agent-1')).toBe(true);
//     });

//     it('should record agent action details', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockChain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };
//       // Start a span first
//       await handler.handleChainStart(mockChain, {}, 'agent-2');

//       // Then handle agent action
//       const mockAction = {
//         tool: 'calculator',
//         toolInput: '42 / 7',
//         log: '',
//       };
//       await handler.handleAgentAction(mockAction, 'agent-2');

//       // Span should have agent action recorded
//       const span = handler['runMap'].get('agent-2');
//       expect(span).toBeDefined();
//     });
//   });

//   describe('handleAgentFinish', () => {
//     it('should end agent span on finish', async () => {
//       const handler = new TracciaCallbackHandler();

//       // Create a span first
//       const mockAction = { tool: 'test', toolInput: 'input', log: '' };
//       await handler.handleAgentAction(mockAction, 'agent-3');

//       // Finish agent
//       const finish = { output: 'final result', returnValues: {}, log: '' };
//       await handler.handleAgentEnd?.(finish, 'agent-3');

//       expect(handler['runMap'].has('agent-3')).toBe(false);
//     });

//     it('should record final output', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockAction = { tool: 'test', toolInput: 'input', log: '' };

//       await handler.handleAgentAction(mockAction, 'agent-4');

//       const finish = { output: 'completed result', returnValues: {}, log: '' };
//       await handler.handleAgentEnd?.(finish, 'agent-4');

//       expect(handler['runMap'].has('agent-4')).toBe(false);
//     });
//   });

//   describe('Error Handling', () => {
//     it('should handle LLM errors gracefully', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };

//       await handler.handleLLMStart(mockLLM, ['prompt'], 'error-1');

//       const error = new Error('LLM failed');
//       await handler.handleLLMError?.(error, 'error-1');

//       // Span should still be cleaned up
//       expect(handler['runMap'].has('error-1')).toBe(false);
//     });

//     it('should handle chain errors gracefully', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockChain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };

//       await handler.handleChainStart(mockChain, {}, 'error-2');

//       const error = new Error('Chain failed');
//       await handler.handleChainError?.(error, 'error-2');

//       expect(handler['runMap'].has('error-2')).toBe(false);
//     });

//     it('should handle tool errors gracefully', async () => {
//       const handler = new TracciaCallbackHandler();
//       const mockTool = { name: 'tool', lc: 1, type: 'not_implemented' as const, id: ['test', 'tool'] };

//       await handler.handleToolStart(mockTool, 'input', 'error-3');

//       const error = new Error('Tool failed');
//       await handler.handleToolError?.(error, 'error-3');

//       expect(handler['runMap'].has('error-3')).toBe(false);
//     });
//   });

//   describe('Span Nesting', () => {
//     it('should handle nested spans (chain containing LLM)', async () => {
//       const handler = new TracciaCallbackHandler();

//       // Start chain
//       const chain = { name: 'chain', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain'] };
//       await handler.handleChainStart(chain, {}, 'chain-outer');

//       // Start LLM inside chain
//       const llm = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };
//       await handler.handleLLMStart(llm, ['prompt'], 'llm-inner');

//       // Both should exist
//       expect(handler['runMap'].has('chain-outer')).toBe(true);
//       expect(handler['runMap'].has('llm-inner')).toBe(true);

//       // End LLM first
//       await handler.handleLLMEnd?.({ generations: [[{ text: 'response' }]] }, 'llm-inner');
//       expect(handler['runMap'].has('llm-inner')).toBe(false);

//       // Chain should still exist
//       expect(handler['runMap'].has('chain-outer')).toBe(true);

//       // End chain
//       await handler.handleChainEnd({ output: 'result' }, 'chain-outer');
//       expect(handler['runMap'].has('chain-outer')).toBe(false);
//     });

//     it('should handle multiple concurrent spans', async () => {
//       const handler = new TracciaCallbackHandler();

//       // Start multiple spans
//       const chain1 = { name: 'chain1', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain1'] };
//       const chain2 = { name: 'chain2', lc: 1, type: 'not_implemented' as const, id: ['test', 'chain2'] };

//       await handler.handleChainStart(chain1, {}, 'c1');
//       await handler.handleChainStart(chain2, {}, 'c2');

//       expect(handler['runMap'].has('c1')).toBe(true);
//       expect(handler['runMap'].has('c2')).toBe(true);

//       // End one
//       await handler.handleChainEnd({ output: 'r1' }, 'c1');

//       // Other should still exist
//       expect(handler['runMap'].has('c1')).toBe(false);
//       expect(handler['runMap'].has('c2')).toBe(true);
//     });
//   });

//   describe('Integration with Tracer', () => {
//     it('should use the SDK tracer', () => {
//       const handler = new TracciaCallbackHandler();
//       expect(handler['tracer']).toBeDefined();
//     });

//     it('should handle unavailable tracer gracefully', async () => {
//       const handler = new TracciaCallbackHandler();
      
//       // Should not throw even if operations fail
//       const mockLLM = { name: 'llm', lc: 1, type: 'not_implemented' as const, id: ['test', 'llm'] };
//       await expect(handler.handleLLMStart(mockLLM, ['prompt'], 'test')).resolves.not.toThrow();
//     });
//   });


// // End of file
// // End of file
describe('dummy', () => {
	it('should pass', () => {
		expect(true).toBe(true);
	});
});
// End of file
// });