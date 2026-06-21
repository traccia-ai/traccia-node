/**
 * Span processor that adds default GovernanceEvent attributes on every span.
 */

import { ISpan, ISpanProcessor } from "../types";
import {
  EVENT_TYPE,
  TIMESTAMP_SOURCE,
  RISK_TIER,
  INTEGRITY_HASH,
} from "../governance/schema";
import { governanceHooks } from "../governance/hooks";

export interface GovernanceEnrichmentOptions {
  defaultEventType?: string;
  euRiskTier?: string;
}

/**
 * Ensures governance.event_type and integrity_hash exist before export.
 */
export class GovernanceEnrichmentProcessor implements ISpanProcessor {
  private defaultEventType: string;
  private euRiskTier?: string;

  constructor(options?: GovernanceEnrichmentOptions) {
    this.defaultEventType = options?.defaultEventType ?? "inference";
    this.euRiskTier = options?.euRiskTier;
  }

  onStart(span: ISpan): void {
    governanceHooks.triggerBeforeExecute(span);
  }

  onEnd(span: ISpan): void {
    if (!span.setAttribute) {
      return;
    }
    
    const attrs = span.attributes || {};
    
    // Set event type if not present (ignore span.type — aligned with traccia-py)
    let eventType = attrs[EVENT_TYPE] as string | undefined;
    if (!eventType) {
      const name = span.name || "";
      eventType = name.toLowerCase().includes("tool") ? "tool_call" : this.defaultEventType;
      span.setAttribute(EVENT_TYPE, eventType);
    }
    
    // Set timestamp source if not present
    if (!attrs[TIMESTAMP_SOURCE]) {
      span.setAttribute(TIMESTAMP_SOURCE, "sdk");
    }
    
    // Set EU AI Act risk tier if configured
    if (this.euRiskTier && !attrs[RISK_TIER]) {
      span.setAttribute(RISK_TIER, this.euRiskTier);
    }
    
    // Set integrity hash if not present
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