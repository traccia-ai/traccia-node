/**
 * Metrics recorder for decoupling metric definition from recording logic.
 */

export interface IMeter {
  recordCounter(name: string, value: number, attributes?: Record<string, string | number>): void;
  recordHistogram(name: string, value: number, attributes?: Record<string, string | number>): void;
  recordGauge(name: string, value: number, attributes?: Record<string, string | number>): void;
}

export class MetricsRecorder {
  private static meter: IMeter | null = null;

  /**
   * Set the active meter implementation
   */
  public static setMeter(meter: IMeter): void {
    MetricsRecorder.meter = meter;
  }

  /**
   * Record a counter value
   */
  public static recordCounter(name: string, value: number, attributes?: Record<string, string | number>): void {
    if (MetricsRecorder.meter) {
      try {
        MetricsRecorder.meter.recordCounter(name, value, attributes);
      } catch (e) {
        console.error('Failed to record counter', e);
      }
    }
  }

  /**
   * Record a histogram value
   */
  public static recordHistogram(name: string, value: number, attributes?: Record<string, string | number>): void {
    if (MetricsRecorder.meter) {
      try {
        MetricsRecorder.meter.recordHistogram(name, value, attributes);
      } catch (e) {
        console.error('Failed to record histogram', e);
      }
    }
  }

  /**
   * Record a gauge value
   */
  public static recordGauge(name: string, value: number, attributes?: Record<string, string | number>): void {
    if (MetricsRecorder.meter) {
      try {
        MetricsRecorder.meter.recordGauge(name, value, attributes);
      } catch (e) {
        console.error('Failed to record gauge', e);
      }
    }
  }
}
