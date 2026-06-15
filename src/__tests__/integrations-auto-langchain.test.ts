import {
  getTraciaHandler,
  withTracing,
  createTracedOpenAI,
  createTracedAgentExecutor,
  createTracedLLMChain,
  setupLangChainWithTracing,
  traced
} from '../integrations/auto-langchain';

// Mock dependencies
jest.mock('@langchain/openai', () => {
  return {
    ChatOpenAI: jest.fn().mockImplementation((config) => {
      return { _mock: 'ChatOpenAI', config };
    }),
  };
}, { virtual: true });

jest.mock('langchain/agents', () => {
  return {
    AgentExecutor: {
      fromAgentAndTools: jest.fn().mockImplementation((options) => {
        return { _mock: 'AgentExecutor', ...options };
      }),
    },
    createOpenAIToolsAgent: jest.fn().mockResolvedValue({ _mock: 'Agent' }),
  };
}, { virtual: true });

jest.mock('langchain/chains', () => {
  return {
    LLMChain: jest.fn().mockImplementation((options) => {
      return { _mock: 'LLMChain', ...options };
    }),
  };
}, { virtual: true });

jest.mock('@langchain/core/prompts', () => {
  return {
    ChatPromptTemplate: {
      fromMessages: jest.fn().mockReturnValue({ _mock: 'PromptTemplate' }),
    },
    MessagesPlaceholder: jest.fn().mockImplementation((name) => {
      return { _mock: 'MessagesPlaceholder', name };
    }),
  };
}, { virtual: true });

jest.mock('../auto', () => {
  return {
    getTracer: jest.fn().mockReturnValue({
      startActiveSpan: jest.fn().mockImplementation((name, fn) => {
        const mockSpan = {
          setAttribute: jest.fn(),
          recordException: jest.fn(),
          end: jest.fn(),
        };
        return fn(mockSpan);
      }),
    }),
  };
});

describe('auto-langchain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getTraciaHandler', () => {
    it('should return a singleton handler', () => {
      const handler1 = getTraciaHandler();
      const handler2 = getTraciaHandler();
      expect(handler1).toBeDefined();
      expect(handler1).toBe(handler2);
    });
  });

  describe('withTracing', () => {
    it('should add handler to component without callbacks', () => {
      const component = { name: 'test' };
      const result = withTracing(component);
      expect((result as any).callbacks).toBeDefined();
      expect((result as any).callbacks.length).toBe(1);
    });

    it('should append handler to existing callbacks array', () => {
      const existingCallback = { name: 'existing' };
      const component = { callbacks: [existingCallback] };
      const result = withTracing(component);
      expect((result as any).callbacks.length).toBe(2);
      expect((result as any).callbacks[0]).toBe(existingCallback);
    });

    it('should convert single callback object to array and append handler', () => {
      const existingCallback = { name: 'existing' };
      const component = { callbacks: existingCallback };
      const result = withTracing(component);
      expect(Array.isArray((result as any).callbacks)).toBe(true);
      expect((result as any).callbacks.length).toBe(2);
      expect((result as any).callbacks[0]).toBe(existingCallback);
    });

    it('should handle null component gracefully', () => {
      const result = withTracing(null);
      expect(result).toBeNull();
    });
  });

  describe('createTracedOpenAI', () => {
    it('should create and trace ChatOpenAI', async () => {
      const config = { modelName: 'gpt-4' };
      const model = await createTracedOpenAI(config);
      expect(model._mock).toBe('ChatOpenAI');
      expect(model.config).toEqual(config);
      expect(model.callbacks).toBeDefined();
    });
  });

  describe('createTracedAgentExecutor', () => {
    it('should create and trace AgentExecutor', async () => {
      const options = {
        agent: { name: 'my-agent' },
        tools: [{ name: 'my-tool' }],
      };
      const executor = await createTracedAgentExecutor(options);
      expect(executor._mock).toBe('AgentExecutor');
      expect(executor.agent).toBe(options.agent);
      expect(executor.tools).toBe(options.tools);
      expect(executor.callbacks).toBeDefined();
    });
  });

  describe('createTracedLLMChain', () => {
    it('should create and trace LLMChain', async () => {
      const options = {
        llm: { name: 'my-llm' },
        prompt: { name: 'my-prompt' },
      };
      const chain = await createTracedLLMChain(options);
      expect(chain._mock).toBe('LLMChain');
      expect(chain.prompt).toBe(options.prompt);
      expect(chain.callbacks).toBeDefined();
      expect(chain.llm.callbacks).toBeDefined();
    });
  });

  describe('setupLangChainWithTracing', () => {
    it('should setup model without tools', async () => {
      const result = await setupLangChainWithTracing({
        modelName: 'gpt-3.5-turbo',
      });
      expect(result.model._mock).toBe('ChatOpenAI');
      expect(result.executor).toBeNull();
      expect(result.handler).toBeDefined();
    });

    it('should setup model and executor when tools are provided', async () => {
      const result = await setupLangChainWithTracing({
        modelName: 'gpt-4',
        tools: [{ name: 'calculator' }],
      });
      expect(result.model._mock).toBe('ChatOpenAI');
      expect(result.executor._mock).toBe('AgentExecutor');
      expect(result.handler).toBeDefined();
    });
  });

  describe('traced decorator', () => {
    it('should trace method execution successfully', async () => {
      class TestClass {
        @traced('test-span')
        async testMethod(arg1: string) {
          return arg1 + '-success';
        }
      }

      const instance = new TestClass();
      const result = await instance.testMethod('hello');
      expect(result).toBe('hello-success');
    });

    it('should trace method error and rethrow', async () => {
      class TestClass {
        @traced('test-span-error')
        async testMethod() {
          throw new Error('Test error');
        }
      }

      const instance = new TestClass();
      await expect(instance.testMethod()).rejects.toThrow('Test error');
    });
  });
});
