/**
 * Helper APIs for explicit guardrail annotation in Traccia traces.
 * 
 * Provides a context-manager for wrapping guardrail checks so they emit
 * properly typed and attributed spans.
 */

import { ISpan } from "../types";
import { getTracer } from "../auto";
import {
  ATTR_GUARDRAIL_CATEGORY,
  ATTR_GUARDRAIL_ENFORCEMENT_MODE,
  ATTR_GUARDRAIL_EVIDENCE_TYPE,
  ATTR_GUARDRAIL_NAME,
  ATTR_GUARDRAIL_SOURCE_SDK,
  ATTR_GUARDRAIL_SUPPRESS_MISSING,
  ATTR_GUARDRAIL_TRIGGERED,
} from "./constants";

/**
 * Options for guardrailSpan.
 */
export interface GuardrailSpanOptions {
  category?: string;
  enforcementMode?: string;
  policyId?: string | null;
  suppressMissing?: string[];
}

/**
 * Build guardrail attributes for a span.
 */
function buildGuardrailAttributes(params: {
  name: string;
  category?: string;
  triggered?: boolean | null;
  enforcementMode?: string;
  policyId?: string | null;
  suppressMissing?: string[];
}): Record<string, unknown> {
  const { name, category = "unknown", triggered, enforcementMode = "unknown", policyId, suppressMissing } = params;
  
  const attrs: Record<string, unknown> = {
    "span.type": "guardrail",
    [ATTR_GUARDRAIL_NAME]: name,
    [ATTR_GUARDRAIL_CATEGORY]: category,
    [ATTR_GUARDRAIL_ENFORCEMENT_MODE]: enforcementMode,
    [ATTR_GUARDRAIL_SOURCE_SDK]: "manual_observe",
    [ATTR_GUARDRAIL_EVIDENCE_TYPE]: "span_attribute",
  };
  
  if (triggered !== undefined && triggered !== null) {
    attrs[ATTR_GUARDRAIL_TRIGGERED] = triggered;
  }
  
  if (policyId !== undefined && policyId !== null) {
    attrs["guardrail.policy_id"] = policyId;
  }
  
  if (suppressMissing && suppressMissing.length > 0) {
    attrs[ATTR_GUARDRAIL_SUPPRESS_MISSING] = suppressMissing;
  }
  
  return attrs;
}

/**
 * Validate guardrail span attributes and return warnings.
 */
export function validateGuardrailAttributes(
  attrs: Record<string, unknown>,
  options?: { requireTriggered?: boolean },
): string[] {
  const warnings: string[] = [];
  const requireTriggered = options?.requireTriggered ?? true;
  
  const requiredKeys = [ATTR_GUARDRAIL_NAME, ATTR_GUARDRAIL_CATEGORY];
  if (requireTriggered) {
    requiredKeys.push(ATTR_GUARDRAIL_TRIGGERED);
  }
  
  for (const key of requiredKeys) {
    if (attrs[key] === undefined || attrs[key] === null) {
      warnings.push(`Missing recommended guardrail attribute: ${key}`);
    }
  }
  
  return warnings;
}

/**
 * Context manager for creating a guardrail-typed span.
 * 
 * Usage:
 * ```typescript
 * import { guardrailSpan } from '@traccia/sdk/guardrails';
 * 
 * const span = await guardrailSpan('pii_check', { category: 'pii' });
 * // ... do guardrail check
 * span.setAttribute('guardrail.triggered', true);
 * span.end();
 * ```
 */
export async function guardrailSpan(
  name: string,
  options?: GuardrailSpanOptions,
): Promise<ISpan> {
  const attrs = buildGuardrailAttributes({
    name,
    category: options?.category,
    enforcementMode: options?.enforcementMode,
    policyId: options?.policyId,
    suppressMissing: options?.suppressMissing,
  });
  
  const tracer = getTracer("traccia.guardrails");
  const span = tracer.startSpan(`guardrail.${name}`, { attributes: attrs });
  return span;
}