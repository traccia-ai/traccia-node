/**
 * Tests for metrics utilities.
 */

import { Meter } from '@opentelemetry/api';
import { StandardMetrics } from '../metrics/meter';
import { MetricsRecorder } from '../metrics/recorder';

const mockMeter = {
  createHistogram: jest.fn().mockImplementation((_name: string, _options: unknown) => ({
    record: jest.fn(),
  })),
  createCounter: jest.fn().mockImplementation((_name: string, _options: unknown) => ({
    add: jest.fn(),
  })),
  createGauge: jest.fn(),
  createObservableGauge: jest.fn(),
  createUpDownCounter: jest.fn(),
  createObservableCounter: jest.fn(),
  createObservableUpDownCounter: jest.fn(),
  addBatchObservableCallback: jest.fn(),
  removeBatchObservableCallback: jest.fn(),
} as unknown as Meter;

describe('StandardMetrics', () => {
  it('should create token histogram', () => {
    const histogram = StandardMetrics.createTokenHistogram(mockMeter);
    expect(histogram).toBeDefined();
  });

  it('should create duration histogram', () => {
    const histogram = StandardMetrics.createDurationHistogram(mockMeter);
    expect(histogram).toBeDefined();
  });

  it('should create cost histogram', () => {
    const histogram = StandardMetrics.createCostHistogram(mockMeter);
    expect(histogram).toBeDefined();
  });

  it('should create exception counter', () => {
    const counter = StandardMetrics.createExceptionCounter(mockMeter);
    expect(counter).toBeDefined();
  });

  it('should create agent runs counter', () => {
    const counter = StandardMetrics.createAgentRunsCounter(mockMeter);
    expect(counter).toBeDefined();
  });

  it('should create all standard metrics', () => {
    const metrics = StandardMetrics.createStandardMetrics(mockMeter);
    expect(metrics.token_histogram).toBeDefined();
    expect(metrics.duration_histogram).toBeDefined();
    expect(metrics.cost_histogram).toBeDefined();
    expect(metrics.exception_counter).toBeDefined();
    expect(metrics.agent_runs_counter).toBeDefined();
    expect(metrics.agent_turns_counter).toBeDefined();
    expect(metrics.agent_execution_time_histogram).toBeDefined();
  });
});

describe('MetricsRecorder', () => {
  it('should record with 100% sample rate', () => {
    const mockHistogram = { record: jest.fn() };
    const recorder = new MetricsRecorder({ token_histogram: mockHistogram as unknown as { record: () => void } }, 1.0);

    recorder.recordTokenUsage(100, 50, { 'gen_ai.system': 'openai' });
    recorder.recordDuration(1.5, { 'gen_ai.system': 'openai' });
    recorder.recordCost(0.01, { 'gen_ai.system': 'openai' });

    expect(mockHistogram.record).toHaveBeenCalled();
  });

  it('should respect sample rate', () => {
    const mockHistogram = { record: jest.fn() };
    const recorder = new MetricsRecorder({ token_histogram: mockHistogram as unknown as { record: () => void } }, 0.0);

    recorder.recordTokenUsage(100, 50);
    expect(mockHistogram.record).not.toHaveBeenCalled();
  });

  it('should record token usage with input/output types', () => {
    const mockHistogram = { record: jest.fn() };
    const recorder = new MetricsRecorder({ token_histogram: mockHistogram as unknown as { record: () => void } }, 1.0);

    recorder.recordTokenUsage(100, 50, { 'gen_ai.request.model': 'gpt-4' });

    expect(mockHistogram.record).toHaveBeenCalledWith(100, { 'gen_ai.request.model': 'gpt-4', 'gen_ai.token.type': 'input' });
    expect(mockHistogram.record).toHaveBeenCalledWith(50, { 'gen_ai.request.model': 'gpt-4', 'gen_ai.token.type': 'output' });
  });

  it('should record agent run and execution time', () => {
    const mockCounter = { add: jest.fn() };
    const mockHistogram = { record: jest.fn() };
    const recorder = new MetricsRecorder({
      agent_runs_counter: mockCounter as unknown as { add: () => void },
      agent_execution_time_histogram: mockHistogram as unknown as { record: () => void },
    }, 1.0);

    recorder.recordAgentRun({ 'agent.id': 'test-agent' });
    recorder.recordAgentExecutionTime(2.5, { 'agent.id': 'test-agent' });

    expect(mockCounter.add).toHaveBeenCalledWith(1, { 'agent.id': 'test-agent' });
    expect(mockHistogram.record).toHaveBeenCalledWith(2.5, { 'agent.id': 'test-agent' });
  });
});