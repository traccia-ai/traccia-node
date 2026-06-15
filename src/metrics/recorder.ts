import { Meter, Histogram, Counter } from "@opentelemetry/api";

export class MetricsRecorder {
  private metrics: Record<string, Histogram | Counter>;
  private sampleRate: number;
  private meter?: Meter;
  private _custom_counters: Record<string, Counter> = {};
  private _custom_histograms: Record<string, Histogram> = {};

  constructor(metrics: Record<string, Histogram | Counter>, sampleRate: number = 1.0) {
    this.metrics = metrics;
    this.sampleRate = sampleRate;
  }

  setMeter(meter: Meter): void {
    this.meter = meter;
  }

  shouldRecord(): boolean {
    if (this.sampleRate >= 1.0) return true;
    return Math.random() <= this.sampleRate;
  }

  recordTokenUsage(
    promptTokens?: number,
    completionTokens?: number,
    attributes?: { [key: string]: string | number | boolean },
  ): void {
    if (!this.shouldRecord()) return;
    const histogram = this.metrics.token_histogram as Histogram;
    if (!histogram) return;
    const attrs = attributes ?? {};
    if (promptTokens !== undefined && promptTokens > 0) {
      histogram.record(promptTokens, { ...attrs, "gen_ai.token.type": "input" });
    }
    if (completionTokens !== undefined && completionTokens > 0) {
      histogram.record(completionTokens, { ...attrs, "gen_ai.token.type": "output" });
    }
  }

  recordDuration(duration: number, attributes?: { [key: string]: string | number | boolean }): void {
    if (!this.shouldRecord()) return;
    const histogram = this.metrics.duration_histogram as Histogram;
    if (histogram && duration > 0) {
      histogram.record(duration, attributes ?? {});
    }
  }

  recordCost(cost: number, attributes?: { [key: string]: string | number | boolean }): void {
    if (!this.shouldRecord()) return;
    const histogram = this.metrics.cost_histogram as Histogram;
    if (histogram && cost > 0) {
      histogram.record(cost, attributes ?? {});
    }
  }

  recordException(attributes?: { [key: string]: string | number | boolean }): void {
    if (!this.shouldRecord()) return;
    const counter = this.metrics.exception_counter as Counter;
    if (counter) {
      counter.add(1, attributes ?? {});
    }
  }

  recordAgentRun(attributes?: { [key: string]: string | number | boolean }): void {
    if (!this.shouldRecord()) return;
    const counter = this.metrics.agent_runs_counter as Counter;
    if (counter) {
      counter.add(1, attributes ?? {});
    }
  }

  recordAgentTurn(attributes?: { [key: string]: string | number | boolean }): void {
    if (!this.shouldRecord()) return;
    const counter = this.metrics.agent_turns_counter as Counter;
    if (counter) {
      counter.add(1, attributes ?? {});
    }
  }

  recordAgentExecutionTime(duration: number, attributes?: { [key: string]: string | number | boolean }): void {
    if (!this.shouldRecord()) return;
    const histogram = this.metrics.agent_execution_time_histogram as Histogram;
    if (histogram && duration > 0) {
      histogram.record(duration, attributes ?? {});
    }
  }

  recordCounter(name: string, value: number = 1, attributes?: { [key: string]: string | number | boolean }): void {
    if (!this.shouldRecord() || !this.meter) return;
    if (!this._custom_counters[name]) {
      this._custom_counters[name] = this.meter.createCounter(name, {
        unit: "1",
        description: `Custom counter: ${name}`,
      });
    }
    this._custom_counters[name].add(value, attributes ?? {});
  }

  recordHistogram(
    name: string,
    value: number,
    attributes?: { [key: string]: string | number | boolean },
    unit: string = "1",
  ): void {
    if (!this.shouldRecord() || !this.meter) return;
    if (!this._custom_histograms[name]) {
      this._custom_histograms[name] = this.meter.createHistogram(name, {
        unit,
        description: `Custom histogram: ${name}`,
      });
    }
    this._custom_histograms[name].record(value, attributes ?? {});
  }
}

let globalRecorder: MetricsRecorder | null = null;

export function setGlobalRecorder(recorder: MetricsRecorder): void {
  globalRecorder = recorder;
}

export function getMetricsRecorder(): MetricsRecorder | null {
  return globalRecorder;
}

export function recordCounter(name: string, value: number = 1, attributes?: { [key: string]: string | number | boolean }): void {
  if (!globalRecorder) return;
  globalRecorder.recordCounter(name, value, attributes);
}

export function recordHistogram(
  name: string,
  value: number,
  attributes?: { [key: string]: string | number | boolean },
  unit?: string,
): void {
  if (!globalRecorder) return;
  globalRecorder.recordHistogram(name, value, attributes, unit);
}
