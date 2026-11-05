import { InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { init, stopTracing, forceFlush } from '../auto';
import { getMetricsRecorder, recordCounter, recordHistogram, recordLlmMetrics } from '../metrics/recorder';
import { wrapOpenAICreate } from '../instrumentation/openai';
import { wrapAnthropicCreate } from '../instrumentation/anthropic';
import { wrapGeminiInteractionsCreate } from '../instrumentation/gemini';

describe('Metrics initialization and provider wiring (TRC-305)', () => {
  afterEach(async () => {
    await stopTracing();
  });

  it('init() initializes a global metrics recorder and exporter', async () => {
    const exporter = new InMemoryMetricExporter(0);

    expect(getMetricsRecorder()).toBeNull();

    await init({
      apiKey: 'test-key',
      endpoint: 'https://api.traccia.ai/v2/traces',
      metricExporter: exporter,
      loadEnv: false,
    });

    const recorder = getMetricsRecorder();
    expect(recorder).not.toBeNull();

    recordCounter('custom.agent.requests', 3, { env: 'test' });
    recordHistogram('custom.agent.latency', 0.25, { env: 'test' });

    await forceFlush();

    const exported = exporter.getMetrics();
    expect(exported.length).toBeGreaterThan(0);

    const metricNames = exported[0].scopeMetrics[0].metrics.map((m) => m.descriptor.name);
    expect(metricNames).toContain('custom.agent.requests');
    expect(metricNames).toContain('custom.agent.latency');
  });

  it('init({ enableMetrics: false }) leaves global recorder null', async () => {
    await init({
      apiKey: 'test-key',
      endpoint: 'https://api.traccia.ai/v2/traces',
      enableMetrics: false,
      loadEnv: false,
    });

    expect(getMetricsRecorder()).toBeNull();
  });

  it('records metrics independently of trace sampling', async () => {
    const exporter = new InMemoryMetricExporter(0);

    await init({
      apiKey: 'test-key',
      endpoint: 'https://api.traccia.ai/v2/traces',
      sampleRate: 0.0,
      metricsSampleRate: 1.0,
      metricExporter: exporter,
      loadEnv: false,
    });

    const recorder = getMetricsRecorder();
    expect(recorder).not.toBeNull();

    recordLlmMetrics({
      vendor: 'openai',
      model: 'gpt-4o',
      promptTokens: 120,
      completionTokens: 45,
      duration: 1.2,
      cost: 0.002,
    });

    await forceFlush();

    const exported = exporter.getMetrics();
    expect(exported.length).toBeGreaterThan(0);

    const metricNames = exported[0].scopeMetrics[0].metrics.map((m) => m.descriptor.name);
    expect(metricNames).toContain('gen_ai.client.token.usage');
    expect(metricNames).toContain('gen_ai.client.operation.duration');
    expect(metricNames).toContain('gen_ai.client.operation.cost');
  });

  it('wires usage metrics through OpenAI chat completions wrapper', async () => {
    const exporter = new InMemoryMetricExporter(0);

    await init({
      apiKey: 'test-key',
      endpoint: 'https://api.traccia.ai/v2/traces',
      metricExporter: exporter,
      loadEnv: false,
    });

    const fakeCreate = jest.fn().mockResolvedValue({
      id: 'chatcmpl-123',
      model: 'gpt-4o-mini',
      choices: [{ message: { content: 'Hello world' } }],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 8,
        total_tokens: 23,
      },
    });

    const wrapped = wrapOpenAICreate(fakeCreate, null);
    await wrapped({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] });

    await forceFlush();

    const exported = exporter.getMetrics();
    expect(exported.length).toBeGreaterThan(0);

    const metricNames = exported[0].scopeMetrics[0].metrics.map((m) => m.descriptor.name);
    expect(metricNames).toContain('gen_ai.client.token.usage');
    expect(metricNames).toContain('gen_ai.client.operation.duration');
  });

  it('wires usage metrics through Anthropic messages wrapper', async () => {
    const exporter = new InMemoryMetricExporter(0);

    await init({
      apiKey: 'test-key',
      endpoint: 'https://api.traccia.ai/v2/traces',
      metricExporter: exporter,
      loadEnv: false,
    });

    const fakeCreate = jest.fn().mockResolvedValue({
      id: 'msg_123',
      model: 'claude-3-haiku-20240307',
      content: [{ type: 'text', text: 'Anthropic response' }],
      usage: {
        input_tokens: 25,
        output_tokens: 12,
      },
    });

    const wrapped = wrapAnthropicCreate(fakeCreate, null);
    await wrapped({ model: 'claude-3-haiku-20240307', messages: [{ role: 'user', content: 'Hi' }] });

    await forceFlush();

    const exported = exporter.getMetrics();
    expect(exported.length).toBeGreaterThan(0);

    const metricNames = exported[0].scopeMetrics[0].metrics.map((m) => m.descriptor.name);
    expect(metricNames).toContain('gen_ai.client.token.usage');
    expect(metricNames).toContain('gen_ai.client.operation.duration');
  });

  it('wires usage metrics through Gemini interactions wrapper', async () => {
    const exporter = new InMemoryMetricExporter(0);

    await init({
      apiKey: 'test-key',
      endpoint: 'https://api.traccia.ai/v2/traces',
      metricExporter: exporter,
      loadEnv: false,
    });

    const fakeCreate = jest.fn().mockResolvedValue({
      id: 'int_123',
      output_text: 'Gemini output',
      usage: {
        total_input_tokens: 30,
        total_output_tokens: 10,
        total_tokens: 40,
      },
    });

    const wrapped = wrapGeminiInteractionsCreate(fakeCreate, null);
    await wrapped({ model: 'gemini-2.0-flash', input: 'Hello' });

    await forceFlush();

    const exported = exporter.getMetrics();
    expect(exported.length).toBeGreaterThan(0);

    const metricNames = exported[0].scopeMetrics[0].metrics.map((m) => m.descriptor.name);
    expect(metricNames).toContain('gen_ai.client.token.usage');
    expect(metricNames).toContain('gen_ai.client.operation.duration');
  });

  it('records exception metrics on LLM failure', async () => {
    const exporter = new InMemoryMetricExporter(0);

    await init({
      apiKey: 'test-key',
      endpoint: 'https://api.traccia.ai/v2/traces',
      metricExporter: exporter,
      loadEnv: false,
    });

    const fakeCreate = jest.fn().mockRejectedValue(new Error('Provider rate limit exceeded'));
    const wrapped = wrapOpenAICreate(fakeCreate, null);

    await expect(
      wrapped({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] })
    ).rejects.toThrow('Provider rate limit exceeded');

    await forceFlush();

    const exported = exporter.getMetrics();
    expect(exported.length).toBeGreaterThan(0);

    const metricNames = exported[0].scopeMetrics[0].metrics.map((m) => m.descriptor.name);
    expect(metricNames).toContain('gen_ai.client.completions.exceptions');
  });
});

