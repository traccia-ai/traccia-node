/**
 * Core metrics utilities for Traccia instrumentation.
 */

import { Meter, Histogram, Counter } from "@opentelemetry/api";

export class StandardMetrics {
  static createTokenHistogram(meter: Meter): Histogram {
    return meter.createHistogram("gen_ai.client.token.usage", {
      unit: "{token}",
      description: "Number of input and output tokens used",
    });
  }

  static createDurationHistogram(meter: Meter): Histogram {
    return meter.createHistogram("gen_ai.client.operation.duration", {
      unit: "s",
      description: "GenAI operation duration",
    });
  }

  static createCostHistogram(meter: Meter): Histogram {
    return meter.createHistogram("gen_ai.client.operation.cost", {
      unit: "usd",
      description: "Cost per LLM operation in USD",
    });
  }

  static createExceptionCounter(meter: Meter): Counter {
    return meter.createCounter("gen_ai.client.completions.exceptions", {
      unit: "1",
      description: "Number of exceptions during LLM operations",
    });
  }

  static createAgentRunsCounter(meter: Meter): Counter {
    return meter.createCounter("gen_ai.agent.runs", {
      unit: "1",
      description: "Number of agent runs",
    });
  }

  static createAgentTurnsCounter(meter: Meter): Counter {
    return meter.createCounter("gen_ai.agent.turns", {
      unit: "1",
      description: "Number of agent turns",
    });
  }

  static createAgentExecutionTimeHistogram(meter: Meter): Histogram {
    return meter.createHistogram("gen_ai.agent.execution_time", {
      unit: "s",
      description: "Agent execution duration",
    });
  }

  static createStandardMetrics(meter: Meter): Record<string, Histogram | Counter> {
    return {
      token_histogram: StandardMetrics.createTokenHistogram(meter),
      duration_histogram: StandardMetrics.createDurationHistogram(meter),
      cost_histogram: StandardMetrics.createCostHistogram(meter),
      exception_counter: StandardMetrics.createExceptionCounter(meter),
      agent_runs_counter: StandardMetrics.createAgentRunsCounter(meter),
      agent_turns_counter: StandardMetrics.createAgentTurnsCounter(meter),
      agent_execution_time_histogram: StandardMetrics.createAgentExecutionTimeHistogram(meter),
    };
  }
}
