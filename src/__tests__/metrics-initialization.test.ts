import * as fs from 'fs';
import * as path from 'path';
import { InMemoryMetricExporter, MeterProvider } from '@opentelemetry/sdk-metrics';
import { metrics as otelMetrics } from '@opentelemetry/api';
import { init, stopTracing, forceFlush } from '../auto';
import { getMetricsRecorder, recordCounter, recordHistogram, recordLlmMetrics } from '../metrics/recorder';
import { wrapOpenAICreate } from '../instrumentation/openai';
import { wrapAnthropicCreate } from '../instrumentation/anthropic';
import { wrapGeminiInteractionsCreate } from '../instrumentation/gemini';
import { TracciaCallbackHandler } from '../integrations/langchain-callback';

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

  it('stopTracing() does not disable application-owned MeterProvider after init({ enableMetrics: false })', async () => {
    const appProvider = new MeterProvider();
    otelMetrics.setGlobalMeterProvider(appProvider);
    expect(otelMetrics.getMeterProvider()).toBe(appProvider);

    try {
      await init({
        apiKey: 'test-key',
        endpoint: 'https://api.traccia.ai/v2/traces',
        enableMetrics: false,
        loadEnv: false,
      });

      await stopTracing();

      // Application MeterProvider must remain active and not disabled
      expect(otelMetrics.getMeterProvider()).toBe(appProvider);
    } finally {
      otelMetrics.disable();
    }
  });

  it('records LangChain metrics on handleLLMError and ignores handleChainError', async () => {
    const exporter = new InMemoryMetricExporter(0);

    await init({
      apiKey: 'test-key',
      endpoint: 'https://api.traccia.ai/v2/traces',
      metricExporter: exporter,
      loadEnv: false,
    });

    const handler = new TracciaCallbackHandler();

    // 1. Unrelated chain error should NOT record an LLM exception metric
    await handler.handleChainError(new Error('Database query in chain failed'), 'chain-run-1');
    await forceFlush();

    let exported = exporter.getMetrics();
    let metricNames = exported.length > 0 ? exported[0].scopeMetrics[0].metrics.map((m) => m.descriptor.name) : [];
    expect(metricNames).not.toContain('gen_ai.client.completions.exceptions');

    // 2. Standalone LLM error SHOULD record an LLM exception metric
    await handler.handleLLMStart(
      { id: ['openai', 'chat'] } as any,
      ['hello'],
      'llm-run-1',
      undefined,
      { invocation_params: { model: 'gpt-4o' } }
    );
    await handler.handleLLMError(new Error('Model timeout'), 'llm-run-1');
    await forceFlush();

    exported = exporter.getMetrics();
    expect(exported.length).toBeGreaterThan(0);
    metricNames = exported[0].scopeMetrics[0].metrics.map((m) => m.descriptor.name);
    expect(metricNames).toContain('gen_ai.client.completions.exceptions');
  });

  it('records LangChain duration for nonstreaming calls and streaming calls starting at generation start', async () => {
    const exporter = new InMemoryMetricExporter(0);

    await init({
      apiKey: 'test-key',
      endpoint: 'https://api.traccia.ai/v2/traces',
      metricExporter: exporter,
      loadEnv: false,
    });

    const handler = new TracciaCallbackHandler();

    // Nonstreaming call: handleLLMStart followed by handleLLMEnd without any tokens
    await handler.handleLLMStart(
      { id: ['openai', 'chat'] } as any,
      ['tell me a joke'],
      'nonstreaming-run',
      undefined,
      { invocation_params: { model: 'gpt-4o' } }
    );
    // Simulate generation latency
    await new Promise((r) => setTimeout(r, 10));

    await handler.handleLLMEnd(
      {
        generations: [[{ text: 'A funny joke' }]],
        llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      } as any,
      'nonstreaming-run'
    );

    await forceFlush();

    const exported = exporter.getMetrics();
    expect(exported.length).toBeGreaterThan(0);
    const durationMetric = exported[0].scopeMetrics[0].metrics.find(
      (m) => m.descriptor.name === 'gen_ai.client.operation.duration'
    );
    expect(durationMetric).toBeDefined();
    // Nonstreaming duration was recorded
    expect(durationMetric?.dataPoints.length).toBeGreaterThan(0);
    const dataPoint = durationMetric?.dataPoints[0] as any;
    expect(dataPoint.value.sum).toBeGreaterThan(0);
  });

  it('exports metrics when root init() and TracciaCallbackHandler from /integrations are loaded from separate bundles', async () => {
    const rootBundlePath = path.join(__dirname, '../../dist/index.js');
    const integrationsBundlePath = path.join(__dirname, '../../dist/integrations/index.js');
    const autoBundlePath = path.join(__dirname, '../../dist/auto.js');
    expect(fs.existsSync(rootBundlePath)).toBe(true);
    expect(fs.existsSync(integrationsBundlePath)).toBe(true);
    expect(fs.existsSync(autoBundlePath)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const rootSdk = require(rootBundlePath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const integrationsSdk = require(integrationsBundlePath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const autoSdk = require(autoBundlePath);

    const exporter = new InMemoryMetricExporter(0);
    try {
      await rootSdk.init({
        apiKey: 'test-key',
        endpoint: 'https://api.traccia.ai/v2/traces',
        metricExporter: exporter,
        loadEnv: false,
      });

      expect(autoSdk.getMetricsRecorder?.() ?? rootSdk.getMetricsRecorder()).toBe(rootSdk.getMetricsRecorder());

      const handler = new integrationsSdk.TracciaCallbackHandler();
      await handler.handleLLMStart(
        { id: ['openai', 'chat'] } as any,
        ['hello across bundles'],
        'bundle-run-1',
        undefined,
        { invocation_params: { model: 'gpt-4o-mini' } },
      );
      await new Promise((r) => setTimeout(r, 10));
      await handler.handleLLMEnd(
        {
          generations: [[{ text: 'ok' }]],
          llmOutput: { tokenUsage: { promptTokens: 12, completionTokens: 6, totalTokens: 18 } },
        } as any,
        'bundle-run-1',
      );

      await rootSdk.forceFlush();

      const exported = exporter.getMetrics();
      expect(exported.length).toBeGreaterThan(0);
      const metricNames = exported[0].scopeMetrics[0].metrics.map((m) => m.descriptor.name);
      expect(metricNames).toContain('gen_ai.client.token.usage');
      expect(metricNames).toContain('gen_ai.client.operation.duration');
    } finally {
      await autoSdk.stopTracing();
    }

    expect(rootSdk.getMetricsRecorder()).toBeNull();
  });
});

