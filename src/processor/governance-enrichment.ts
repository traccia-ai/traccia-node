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

  onEnd(span: ISpan): void {
    if (!span.setAttribute) {
      return;
    }
    
    const attrs = span.attributes || {};
    
    // Set event type if not present
    const eventType = (attrs[EVENT_TYPE] as string) || (attrs["span.type"] as string);
    if (!eventType) {
      const name = span.name || "";
      const inferredType = name.includes("tool") ? "tool_call" : this.defaultEventType;
      span.setAttribute(EVENT_TYPE, inferredType);
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
      const eventType = (attrs[EVENT_TYPE] as string) || this.defaultEventType;
      const payload = `${traceId}:${spanId}:${eventType}`;
      const hash = crypto.createHash("sha256").update(payload).digest("hex");
      span.setAttribute(INTEGRITY_HASH, hash);
    }
  }

  shutdown(): void {
    // No-op
  }

  forceFlush(_timeout?: number): void {
    // No-op
  }
}