/**
 * Span processor that detects guardrails from span attributes and writes
 * findings directly onto spans so they flow through the OTel export pipeline.
 * 
 * Per-span findings are written as attributes on each span that produces them.
 * The aggregated summary (detected, missing, capabilities) is written onto the
 * root span when it ends -- by that point all child spans have already been
 * processed, so the full picture is available.
 * 
 * State is scoped by trace_id, making this safe for concurrent runs.
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
}

/**
 * Guardrail detector processor.
 */
export class GuardrailDetectorProcessor implements ISpanProcessor {
  private heuristicsEnabled: boolean;
  private traces: Map<string, TraceState> = new Map();

  constructor(options?: GuardrailDetectorOptions) {
    this.heuristicsEnabled = options?.heuristicsEnabled ?? true;
  }

  /**
   * Called before OTel span.end(); span is still mutable.
   */
  onEnd(span: ISpan): void {
    try {
      const attrs = span.attributes;
      const spanId = span.context.spanId;
      const traceId = span.context.traceId;

      if (!traceId) {
        return;
      }

      // Detect findings from this span
      const findings = detectAll(
        attrs,
        traceId,
        spanId,
        this.heuristicsEnabled,
      );

      // Write per-span findings as attributes
      if (findings.length > 0) {
        span.setAttribute("guardrail.finding.count", findings.length);
        try {
          const findingsJson = JSON.stringify(findings.map((f) => ({
            ...f,
            id: f.id,
            status: f.status,
          })));
          span.setAttribute("guardrail.findings", findingsJson);
        } catch {
          // Silently fail on JSON serialization
        }
      }

      // Accumulate into trace-scoped state
      let state = this.traces.get(traceId);
      if (!state) {
        state = { spanAttrs: [], spanIds: [], findings: [] };
        this.traces.set(traceId, state);
      }
      state.spanAttrs.push(attrs);
      state.spanIds.push(spanId);
      state.findings.push(...findings);

      // If this is the root span, compute and write the aggregated summary
      // Root span has no parent
      const isRoot = !span.context.traceState || span.parentSpanId === undefined;
      if (isRoot) {
        this.writeSummary(span, traceId);
      }
    } catch (exc) {
      // Log warning but don't crash
      console.warn(
        `[Traccia] GuardrailDetectorProcessor.onEnd failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }

  /**
   * Compute the full guardrail summary and write it onto the root span.
   */
  private writeSummary(span: ISpan, traceId: string): void {
    const state = this.traces.get(traceId);

    if (!state) {
      return;
    }

    // Remove this trace state now that we're processing the summary
    this.traces.delete(traceId);

    try {
      const summary = evaluateRun({
        allSpanAttrs: state.spanAttrs,
        spanIds: state.spanIds,
        findings: state.findings,
        heuristicsEnabled: this.heuristicsEnabled,
      });

      span.setAttribute("guardrail.summary", JSON.stringify({
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
      }));
      span.setAttribute(
        "guardrail.summary.detected_categories",
        summary.detected_categories,
      );
      span.setAttribute(
        "guardrail.summary.missing_count",
        summary.missing_categories.length,
      );
      span.setAttribute(
        "guardrail.summary.coverage_confidence",
        summary.coverage_confidence,
      );

      // Also write the full findings list on the root span
      if (state.findings.length > 0) {
        span.setAttribute(
          "guardrail.findings",
          JSON.stringify(state.findings.map((f) => ({ ...f }))),
        );
        span.setAttribute("guardrail.finding.count", state.findings.length);
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
    // No-op - guardrails are computed on span end, not batched
  }
}