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
import { REDACTION_APPLIED, redactString, redactValue } from "../redaction";

export interface GuardrailDetectorOptions {
  heuristicsEnabled?: boolean;
}

function isLocalRootSpan(span: ISpan): boolean {
  if ((span as any).isLocalRoot !== undefined) {
    return Boolean((span as any).isLocalRoot);
  }
  const parentSpanId = span.parentSpanId ?? (span as any).parent_span_id;
  if (!parentSpanId) {
    return true;
  }
  return Boolean(
    span.isRemoteParent ??
    (span as any).parentSpanContext?.isRemote ??
    (span as any).otelSpan?.parentSpanContext?.isRemote ??
    (span as any).parentContext?.isRemote
  );
}

interface TraceState {
  spanAttrs: Record<string, unknown>[];
  spanIds: (string | null)[];
  findings: GuardrailFindingWithMeta[];
  rootSpan?: ISpan;
  rootEnded?: boolean;
}

export class GuardrailDetectorProcessor implements ISpanProcessor {
  private heuristicsEnabled: boolean;
  private traces: Map<string, TraceState> = new Map();

  constructor(options?: GuardrailDetectorOptions) {
    this.heuristicsEnabled = options?.heuristicsEnabled ?? true;
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
        state = { spanAttrs: [], spanIds: [], findings: [] };
        this.traces.set(traceId, state);
      }
      state.spanAttrs.push(attrs);
      state.spanIds.push(spanId);
      state.findings.push(...findings);

      const isRoot = isLocalRootSpan(span);
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

      let summaryJson = JSON.stringify({
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

      const isAlreadyRedacted = Boolean(span.attributes?.[REDACTION_APPLIED]);
      const rawFindings = isAlreadyRedacted
        ? (redactValue(state.findings, { sensitive: true }) as GuardrailFindingWithMeta[])
        : state.findings;

      let findingsJson = rawFindings.length > 0
        ? JSON.stringify(rawFindings.map((f) => ({ ...f })))
        : undefined;

      if (isAlreadyRedacted) {
        summaryJson = redactString(summaryJson);
        if (findingsJson) {
          findingsJson = redactString(findingsJson);
        }
      }

      span.setAttribute("guardrail.summary", summaryJson);
      span.setAttribute("guardrail.summary.detected_categories", summary.detected_categories);
      span.setAttribute("guardrail.summary.missing_count", summary.missing_categories.length);
      span.setAttribute("guardrail.summary.coverage_confidence", summary.coverage_confidence);

      if (span.attributes) {
        span.attributes["guardrail.summary"] = summaryJson;
        span.attributes["guardrail.summary.detected_categories"] = summary.detected_categories;
        span.attributes["guardrail.summary.missing_count"] = summary.missing_categories.length;
        span.attributes["guardrail.summary.coverage_confidence"] = summary.coverage_confidence;
        if (isAlreadyRedacted) {
          span.attributes[REDACTION_APPLIED] = true;
        }
      }

      if (findingsJson) {
        span.setAttribute("guardrail.findings", findingsJson);
        span.setAttribute("guardrail.finding.count", rawFindings.length);
        if (span.attributes) {
          span.attributes["guardrail.findings"] = findingsJson;
          span.attributes["guardrail.finding.count"] = rawFindings.length;
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
