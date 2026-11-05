import { Meter, Histogram, Counter } from "@opentelemetry/api";
import { getAgentId, getAgentName, getEnv } from '../config/runtime-config';
import { computeCost } from '../processor/cost-processor';

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

const RUNTIME_KEY = Symbol.for('traccia.runtime');

interface MetricsRuntimeState {
  metricsRecorder?: MetricsRecorder | null;
}

/** One process shares the recorder across separately bundled SDK entry points. */
function recorderRuntimeState(): MetricsRuntimeState {
  const host = globalThis as typeof globalThis & { [RUNTIME_KEY]?: MetricsRuntimeState };
  if (!host[RUNTIME_KEY]) {
    host[RUNTIME_KEY] = {};
  }
  return host[RUNTIME_KEY];
}

export function setGlobalRecorder(recorder: MetricsRecorder | null): void {
  recorderRuntimeState().metricsRecorder = recorder;
}

export function getMetricsRecorder(): MetricsRecorder | null {
  return recorderRuntimeState().metricsRecorder ?? null;
}

export function recordCounter(name: string, value: number = 1, attributes?: { [key: string]: string | number | boolean }): void {
  const recorder = getMetricsRecorder();
  if (!recorder) return;
  recorder.recordCounter(name, value, attributes);
}

export function recordHistogram(
  name: string,
  value: number,
  attributes?: { [key: string]: string | number | boolean },
  unit?: string,
): void {
  const recorder = getMetricsRecorder();
  if (!recorder) return;
  recorder.recordHistogram(name, value, attributes, unit);
}

export interface RecordLlmMetricsOptions {
  vendor: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  duration?: number;
  cost?: number;
  error?: boolean;
}

export function recordLlmMetrics(options: RecordLlmMetricsOptions): void {
  try {
    const recorder = getMetricsRecorder();
    if (!recorder) return;

    const attributes: Record<string, string | number | boolean> = {
      'gen_ai.system': options.vendor,
    };
    if (options.model) {
      attributes['gen_ai.request.model'] = options.model;
    }
    const agentId = getAgentId();
    if (agentId) {
      attributes['agent.id'] = agentId;
      attributes['agent_id'] = agentId;
    }
    const agentName = getAgentName();
    if (agentName) {
      attributes['agent.name'] = agentName;
    }
    const env = getEnv();
    if (env) {
      attributes['environment'] = env;
      attributes['env'] = env;
    }

    if (options.promptTokens !== undefined || options.completionTokens !== undefined) {
      recorder.recordTokenUsage(options.promptTokens, options.completionTokens, attributes);
    }
    if (options.duration !== undefined && options.duration > 0) {
      recorder.recordDuration(options.duration, attributes);
    }
    const cost =
      options.cost ??
      (options.model && (options.promptTokens !== undefined || options.completionTokens !== undefined)
        ? computeCost(options.model, options.promptTokens || 0, options.completionTokens || 0)
        : undefined);
    if (cost !== undefined && cost > 0) {
      recorder.recordCost(cost, attributes);
    }
    if (options.error) {
      recorder.recordException(attributes);
    }
  } catch {
    // Ignore metrics recording failures
  }
}
