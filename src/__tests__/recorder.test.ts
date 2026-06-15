import { MetricsRecorder, setGlobalRecorder, getMetricsRecorder, recordCounter, recordHistogram } from '../metrics/recorder';
import { Meter, Histogram, Counter } from "@opentelemetry/api";

describe('MetricsRecorder', () => {
  let mockHistogram: jest.Mocked<Histogram>;
  let mockCounter: jest.Mocked<Counter>;
  let mockMeter: jest.Mocked<Meter>;
  let recorder: MetricsRecorder;

  beforeEach(() => {
    mockHistogram = {
      record: jest.fn(),
    } as any;

    mockCounter = {
      add: jest.fn(),
    } as any;

    mockMeter = {
      createCounter: jest.fn().mockReturnValue(mockCounter),
      createHistogram: jest.fn().mockReturnValue(mockHistogram),
    } as any;

    const metrics = {
      token_histogram: mockHistogram,
      duration_histogram: mockHistogram,
      cost_histogram: mockHistogram,
      exception_counter: mockCounter,
      agent_runs_counter: mockCounter,
      agent_turns_counter: mockCounter,
      agent_execution_time_histogram: mockHistogram,
    };

    recorder = new MetricsRecorder(metrics, 1.0);
    recorder.setMeter(mockMeter);
  });

  afterEach(() => {
    setGlobalRecorder(null as any);
  });

  describe('shouldRecord', () => {
    it('returns true if sample rate is 1.0', () => {
      expect(recorder.shouldRecord()).toBe(true);
    });

    it('returns false if random > sample rate', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.9);
      const sampler = new MetricsRecorder({}, 0.5);
      expect(sampler.shouldRecord()).toBe(false);
      jest.spyOn(Math, 'random').mockRestore();
    });

    it('returns true if random <= sample rate', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.4);
      const sampler = new MetricsRecorder({}, 0.5);
      expect(sampler.shouldRecord()).toBe(true);
      jest.spyOn(Math, 'random').mockRestore();
    });
  });

  describe('recording methods', () => {
    it('recordTokenUsage', () => {
      recorder.recordTokenUsage(10, 20, { model: 'test' });
      expect(mockHistogram.record).toHaveBeenCalledWith(10, { model: 'test', 'gen_ai.token.type': 'input' });
      expect(mockHistogram.record).toHaveBeenCalledWith(20, { model: 'test', 'gen_ai.token.type': 'output' });
    });

    it('recordDuration', () => {
      recorder.recordDuration(150, { test: 1 });
      expect(mockHistogram.record).toHaveBeenCalledWith(150, { test: 1 });
    });

    it('recordCost', () => {
      recorder.recordCost(0.5, { model: 'test' });
      expect(mockHistogram.record).toHaveBeenCalledWith(0.5, { model: 'test' });
    });

    it('recordException', () => {
      recorder.recordException({ error: 'test' });
      expect(mockCounter.add).toHaveBeenCalledWith(1, { error: 'test' });
    });

    it('recordAgentRun', () => {
      recorder.recordAgentRun({ agent: 'test' });
      expect(mockCounter.add).toHaveBeenCalledWith(1, { agent: 'test' });
    });

    it('recordAgentTurn', () => {
      recorder.recordAgentTurn({ turn: 1 });
      expect(mockCounter.add).toHaveBeenCalledWith(1, { turn: 1 });
    });

    it('recordAgentExecutionTime', () => {
      recorder.recordAgentExecutionTime(300, { agent: 'test' });
      expect(mockHistogram.record).toHaveBeenCalledWith(300, { agent: 'test' });
    });

    it('recordCounter - custom', () => {
      recorder.recordCounter('custom_count', 2, { tag: 'a' });
      expect(mockMeter.createCounter).toHaveBeenCalledWith('custom_count', expect.any(Object));
      expect(mockCounter.add).toHaveBeenCalledWith(2, { tag: 'a' });
      
      // Called again uses cached counter
      recorder.recordCounter('custom_count', 3);
      expect(mockMeter.createCounter).toHaveBeenCalledTimes(1);
      expect(mockCounter.add).toHaveBeenCalledWith(3, {});
    });

    it('recordHistogram - custom', () => {
      recorder.recordHistogram('custom_hist', 42, { tag: 'b' }, 'ms');
      expect(mockMeter.createHistogram).toHaveBeenCalledWith('custom_hist', expect.any(Object));
      expect(mockHistogram.record).toHaveBeenCalledWith(42, { tag: 'b' });

      // Called again uses cached histogram
      recorder.recordHistogram('custom_hist', 10);
      expect(mockMeter.createHistogram).toHaveBeenCalledTimes(1);
      expect(mockHistogram.record).toHaveBeenCalledWith(10, {});
    });
  });

  describe('global recorder functions', () => {
    it('sets and gets global recorder', () => {
      setGlobalRecorder(recorder);
      expect(getMetricsRecorder()).toBe(recorder);
    });

    it('forwards recordCounter', () => {
      setGlobalRecorder(recorder);
      recordCounter('global_count', 5, { foo: 'bar' });
      expect(mockCounter.add).toHaveBeenCalledWith(5, { foo: 'bar' });
    });

    it('forwards recordHistogram', () => {
      setGlobalRecorder(recorder);
      recordHistogram('global_hist', 99, { baz: 'qux' });
      expect(mockHistogram.record).toHaveBeenCalledWith(99, { baz: 'qux' });
    });

    it('fails silently if no global recorder', () => {
      setGlobalRecorder(null as any);
      expect(() => recordCounter('test', 1)).not.toThrow();
      expect(() => recordHistogram('test', 1)).not.toThrow();
    });
  });
});
