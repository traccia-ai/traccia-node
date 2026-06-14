import { MetricsRecorder, IMeter } from '../metrics/recorder';

describe('MetricsRecorder', () => {
  afterEach(() => {
    // Reset global recorder by setting null (casting as IMeter for internal testing)
    MetricsRecorder.setMeter(null as any as IMeter);
  });

  it('should allow setting and getting the global recorder', () => {
    const mockRecorder: IMeter = {
      recordCounter: jest.fn(),
      recordHistogram: jest.fn(),
      recordGauge: jest.fn()
    };

    MetricsRecorder.setMeter(mockRecorder);
    MetricsRecorder.recordCounter('test', 1);

    expect(mockRecorder.recordCounter).toHaveBeenCalledWith('test', 1, undefined);
  });

  it('should fail silently if no meter set', () => {
    // Should not throw
    expect(() => MetricsRecorder.recordCounter('test', 1)).not.toThrow();
    expect(() => MetricsRecorder.recordHistogram('test', 1)).not.toThrow();
    expect(() => MetricsRecorder.recordGauge('test', 1)).not.toThrow();
  });
});
