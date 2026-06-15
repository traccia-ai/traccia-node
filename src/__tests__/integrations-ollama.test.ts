import {
  createOllamaWithTracing,
  setupOllamaWithTracing,
  createOllamaChatbot,
  getOllamaSetupInstructions,
  createOllamaStreamingChatbot,
  POPULAR_OLLAMA_MODELS,
} from '../integrations/ollama-integration';

jest.mock('@langchain/ollama', () => {
  return {
    Ollama: jest.fn().mockImplementation((config) => {
      return {
        _mock: 'Ollama',
        config,
        invoke: jest.fn().mockResolvedValue('mock response'),
        stream: jest.fn().mockResolvedValue([{ text: 'mock ' }, { text: 'stream' }]),
      };
    }),
  };
}, { virtual: true });

jest.mock('../integrations/auto-langchain', () => {
  return {
    getTraciaHandler: jest.fn().mockReturnValue({ _mock: 'TracciaCallbackHandler' }),
    withTracing: jest.fn().mockImplementation((model) => {
      return { ...model, _traced: true };
    }),
    setupLangChainWithTracing: jest.fn().mockResolvedValue({
      executor: { _mock: 'Executor' }
    }),
  };
});

jest.mock('../auto', () => {
  return {
    getTracer: jest.fn().mockReturnValue({
      startActiveSpan: jest.fn().mockImplementation(async (name, fn) => {
        const mockSpan = {
          setAttribute: jest.fn(),
          recordException: jest.fn(),
        };
        return await fn(mockSpan);
      }),
    }),
  };
});

describe('ollama-integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createOllamaWithTracing', () => {
    it('should create and trace Ollama model', async () => {
      const model = await createOllamaWithTracing({ model: 'llama2' });
      expect(model._mock).toBe('Ollama');
      expect(model._traced).toBe(true);
      expect(model.config.model).toBe('llama2');
      expect(model.config.baseUrl).toBe('http://localhost:11434');
    });

    it('should pass through extra config', async () => {
      const model = await createOllamaWithTracing({
        model: 'mistral',
        temperature: 0.5,
        topK: 10
      });
      expect(model.config.temperature).toBe(0.5);
      expect(model.config.topK).toBe(10);
    });
  });

  describe('setupOllamaWithTracing', () => {
    it('should setup Ollama with LangChain', async () => {
      const result = await setupOllamaWithTracing({
        model: 'llama2',
        tools: [{ name: 'test-tool' }],
      });

      expect(result.model._mock).toBe('Ollama');
      expect(result.model.config.model).toBe('llama2');
      expect(result.executor._mock).toBe('Executor');
      expect(result.handler._mock).toBe('TracciaCallbackHandler');
    });
  });

  describe('createOllamaChatbot', () => {
    it('should create a chatbot function', async () => {
      const chatbot = await createOllamaChatbot({ model: 'llama2' });
      expect(typeof chatbot).toBe('function');
      
      const response = await chatbot('hello');
      expect(response).toBe('mock response');
    });
    
    it('should trace exceptions', async () => {
      // Temporarily override the invoke mock to throw
      const error = new Error('ollama error');
      const { Ollama } = require('@langchain/ollama');
      Ollama.mockImplementationOnce(() => ({
        invoke: jest.fn().mockRejectedValue(error)
      }));

      const chatbot = await createOllamaChatbot({ model: 'llama2' });
      await expect(chatbot('hello')).rejects.toThrow('ollama error');
    });
  });

  describe('getOllamaSetupInstructions', () => {
    it('should return instructions containing popular models', () => {
      const instructions = getOllamaSetupInstructions();
      expect(instructions).toContain('Ollama Setup Instructions');
      POPULAR_OLLAMA_MODELS.forEach(m => {
        expect(instructions).toContain(m.name);
      });
    });
  });

  describe('createOllamaStreamingChatbot', () => {
    it('should create a streaming chatbot function and process chunks', async () => {
      let output = '';
      const chatbot = await createOllamaStreamingChatbot({
        model: 'llama2',
        onChunk: (chunk) => { output += chunk; }
      });
      
      expect(typeof chatbot).toBe('function');
      
      await chatbot('hello');
      expect(output).toBe('mock stream');
    });

    it('should fallback to invoke if stream is unavailable', async () => {
      const { Ollama } = require('@langchain/ollama');
      Ollama.mockImplementationOnce(() => ({
        invoke: jest.fn().mockResolvedValue('fallback response'),
        // No stream method
      }));

      let output = '';
      const chatbot = await createOllamaStreamingChatbot({
        model: 'llama2',
        onChunk: (chunk) => { output += chunk; }
      });

      await chatbot('hello');
      expect(output).toBe('fallback response');
    });
    
    it('should trace exceptions in stream', async () => {
      const error = new Error('stream error');
      const { Ollama } = require('@langchain/ollama');
      Ollama.mockImplementationOnce(() => ({
        stream: jest.fn().mockRejectedValue(error)
      }));

      const chatbot = await createOllamaStreamingChatbot({ model: 'llama2' });
      await expect(chatbot('hello')).rejects.toThrow('stream error');
    });
  });
});
