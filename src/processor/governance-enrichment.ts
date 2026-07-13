/**
 * Span processor that adds default GovernanceEvent attributes on every span.
 */

import { ISpan, ISpanProcessor } from "../types";
import {
  EVENT_TYPE,
  TIMESTAMP_SOURCE,
  RISK_TIER,
  INTEGRITY_HASH,
  REDACTION_APPLIED,
  HIPAA_FRAMEWORK_ENABLED,
  HIPAA_PHI_REDACTION_APPLIED,
} from "../governance/schema";
import { governanceHooks } from "../governance/hooks";

export interface GovernanceEnrichmentOptions {
  defaultEventType?: string;
  euRiskTier?: string;
  hipaaEnabled?: boolean;
}

let hipaaWarned = false;

/**
 * Ensures governance.event_type and integrity_hash exist before export.
 */
export class GovernanceEnrichmentProcessor implements ISpanProcessor {
  private defaultEventType: string;
  private euRiskTier?: string;
  private hipaaEnabled: boolean;

  constructor(options?: GovernanceEnrichmentOptions) {
    this.defaultEventType = options?.defaultEventType ?? "inference";
    this.euRiskTier = options?.euRiskTier;
    this.hipaaEnabled = !!options?.hipaaEnabled;
  }

  onStart(span: ISpan): void {
    governanceHooks.triggerBeforeExecute(span);
  }

  onEnd(span: ISpan): void {
    if (!span.setAttribute) {
      return;
    }

    const attrs = span.attributes || {};

    let eventType = attrs[EVENT_TYPE] as string | undefined;
    if (!eventType) {
      const name = span.name || "";
      eventType = name.toLowerCase().includes("tool") ? "tool_call" : this.defaultEventType;
      span.setAttribute(EVENT_TYPE, eventType);
    }

    if (!attrs[TIMESTAMP_SOURCE]) {
      span.setAttribute(TIMESTAMP_SOURCE, "sdk");
    }

    if (this.euRiskTier && !attrs[RISK_TIER]) {
      span.setAttribute(RISK_TIER, this.euRiskTier);
    }

    if (this.hipaaEnabled) {
      if (!attrs[HIPAA_FRAMEWORK_ENABLED]) {
        span.setAttribute(HIPAA_FRAMEWORK_ENABLED, true);
      }
      if (attrs[REDACTION_APPLIED] && !attrs[HIPAA_PHI_REDACTION_APPLIED]) {
        span.setAttribute(HIPAA_PHI_REDACTION_APPLIED, true);
      }
      if (!hipaaWarned) {
        hipaaWarned = true;
        console.warn(
          "[traccia.governance] HIPAA framework enabled on spans. Prefer redactPii: true. " +
            "Traccia Cloud does not currently offer a signed BAA — contact the Traccia team for healthcare onboarding. " +
            "Enabling this does not make you HIPAA compliant.",
        );
      }
    }

    if (!attrs[INTEGRITY_HASH]) {
      const crypto = require("crypto");
      const traceId = span.context?.traceId || "";
      const spanId = span.context?.spanId || "";
      const eventTypeForHash = (span.attributes[EVENT_TYPE] as string) || this.defaultEventType;
      const payload = `${traceId}:${spanId}:${eventTypeForHash}`;
      const hash = crypto.createHash("sha256").update(payload).digest("hex");
      span.setAttribute(INTEGRITY_HASH, hash);
    }

    governanceHooks.triggerAfterExecute(span);
  }

  shutdown(): void {
    // No-op
  }

  forceFlush(_timeout?: number): void {
    // No-op
  }
}
