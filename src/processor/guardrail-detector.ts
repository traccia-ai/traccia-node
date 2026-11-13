/**
 * Span processor that detects guardrails and writes aggregated summaries to root spans.
 */

import { ISpan, ISpanProcessor } from "../types";
import {
  GuardrailFindingWithMeta,
  evaluateRun,
} from "../guardrails";
import { detectAll } from "../guardrails/detectors";

export interface GuardrailDetectorOptions {
  heuristicsEnabled?: boolean;
}

interface TraceState {
  spanAttrs: Record<string, unknown>[];
  spanIds: (string | null)[];
  findings: GuardrailFindingWithMeta[];
  rootSpan?: ISpan;
  rootEnded?: boolean;
}

export class GuardrailDetectorProcessor implements ISpanProcessor {
  private static readonly MAX_TRACES = 10000;
  private heuristicsEnabled: boolean;
  private traces: Map<string, TraceState> = new Map();

  constructor(options?: GuardrailDetectorOptions) {
    this.heuristicsEnabled = options?.heuristicsEnabled ?? true;
  }

  public getTraceCount(): number {
    return this.traces.size;
  }

  onEnd(span: ISpan): void {
    try {
      const attrs = span.attributes;
      const spanId = span.context.spanId;
      const traceId = span.context.traceId;

      if (!traceId) {
        return;
      }

      const findings = detectAll(
        attrs,
        traceId,
        spanId,
        this.heuristicsEnabled,
      );

      if (findings.length > 0) {
        span.setAttribute("guardrail.finding.count", findings.length);
        try {
          span.setAttribute("guardrail.findings", JSON.stringify(findings.map((f) => ({
            ...f,
            id: f.id,
            status: f.status,
          }))));
        } catch {
          // Serialization failure ignored
        }
      }

      let state = this.traces.get(traceId);
      if (!state) {
        if (this.traces.size >= GuardrailDetectorProcessor.MAX_TRACES) {
          const oldestKey = this.traces.keys().next().value;
          if (oldestKey !== undefined) {
            this.traces.delete(oldestKey);
          }
        }
        state = { spanAttrs: [], spanIds: [], findings: [] };
        this.traces.set(traceId, state);
      }
      state.spanAttrs.push(attrs);
      state.spanIds.push(spanId);
      state.findings.push(...findings);

      const parentSpanId = span.parentSpanId ?? (span as any).parent_span_id;
      const isRoot = (span as any).isLocalRoot ?? (!parentSpanId || Boolean((span as any).isRemoteParent));
      if (isRoot) {
        state.rootSpan = span;
        state.rootEnded = true;
        this.writeSummary(span, traceId);
      } else if (state.rootEnded && state.rootSpan) {
        this.writeSummary(state.rootSpan, traceId);
      }
    } catch (exc) {
      console.warn(
        `[Traccia] GuardrailDetectorProcessor.onEnd failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }

  private writeSummary(span: ISpan, traceId: string): void {
    const state = this.traces.get(traceId);
    if (!state) {
      return;
    }

    try {
      const summary = evaluateRun({
        allSpanAttrs: state.spanAttrs,
        spanIds: state.spanIds,
        findings: state.findings,
        heuristicsEnabled: this.heuristicsEnabled,
      });

      const summaryJson = JSON.stringify({
        detected_categories: summary.detected_categories,
        triggered_categories: summary.triggered_categories,
        missing_categories: summary.missing_categories.map((m) => ({
          category: m.category,
          why_required: m.why_required,
          missing_confidence: m.missing_confidence,
          evidence_ref: m.evidence_ref,
        })),
        coverage_confidence: summary.coverage_confidence,
        capabilities_observed: summary.capabilities_observed,
        limitations: summary.limitations,
      });

      span.setAttribute("guardrail.summary", summaryJson);
      span.setAttribute("guardrail.summary.detected_categories", summary.detected_categories);
      span.setAttribute("guardrail.summary.missing_count", summary.missing_categories.length);
      span.setAttribute("guardrail.summary.coverage_confidence", summary.coverage_confidence);

      if (span.attributes) {
        span.attributes["guardrail.summary"] = summaryJson;
        span.attributes["guardrail.summary.detected_categories"] = summary.detected_categories;
        span.attributes["guardrail.summary.missing_count"] = summary.missing_categories.length;
        span.attributes["guardrail.summary.coverage_confidence"] = summary.coverage_confidence;
      }

      if (state.findings.length > 0) {
        const findingsJson = JSON.stringify(state.findings.map((f) => ({ ...f })));
        span.setAttribute("guardrail.findings", findingsJson);
        span.setAttribute("guardrail.finding.count", state.findings.length);
        if (span.attributes) {
          span.attributes["guardrail.findings"] = findingsJson;
          span.attributes["guardrail.finding.count"] = state.findings.length;
        }
      }
    } catch (exc) {
      console.warn(
        `[Traccia] GuardrailDetectorProcessor.writeSummary failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }

  shutdown(): void {
    this.traces.clear();
  }

  forceFlush(_timeout?: number): void {
  }
}
