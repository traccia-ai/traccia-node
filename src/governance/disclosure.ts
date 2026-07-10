/**
 * EU AI Act Art. 50 transparency and attribute enrichment helpers.
 */

import * as crypto from 'crypto';
import { getCurrentSpan } from '../context/context';
import {
  EVENT_TYPE,
  TIMESTAMP_SOURCE,
  MODEL_ID,
  MODEL_VERSION,
  INPUT_HASH,
  OUTPUT_HASH,
  SESSION_ID,
  RISK_TIER,
  INTEGRITY_HASH,
  TRANSPARENCY_DISCLOSED,
  CONTENT_SYNTHETIC,
} from './schema';

export interface DisclosureOptions {
  channel?: string;
  disclosedToUser?: boolean;
  syntheticContent?: boolean;
  generator?: string;
}

/**
 * Record that the end user was informed they are interacting with AI (EU AI Act Art. 50).
 * Writes trace evidence only — does not display UI.
 */
export function disclosure(options: DisclosureOptions = {}): void {
  const {
    channel = 'ui',
    disclosedToUser = true,
    syntheticContent = false,
    generator,
  } = options;

  const span = getCurrentSpan();
  if (!span) {
    return;
  }

  span.setAttribute(EVENT_TYPE, 'transparency');
  span.setAttribute(TRANSPARENCY_DISCLOSED, disclosedToUser);
  span.setAttribute('governance.transparency.channel', channel);
  if (syntheticContent) {
    span.setAttribute(CONTENT_SYNTHETIC, true);
    if (generator) {
      span.setAttribute('governance.content.generator', generator);
    }
  }
}

function hashText(value?: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface EnrichGovernanceAttributesOptions {
  eventType?: string;
  modelId?: string;
  modelVersion?: string;
  inputText?: string;
  outputText?: string;
  sessionId?: string;
  euRiskTier?: string;
}

/** Merge governance attributes into a span attribute dict. */
export function enrichGovernanceAttributes(
  attributes: Record<string, unknown>,
  options: EnrichGovernanceAttributesOptions = {},
): Record<string, unknown> {
  const out = { ...attributes };
  const eventType = options.eventType ?? 'inference';
  out[EVENT_TYPE] = eventType;
  out[TIMESTAMP_SOURCE] = 'sdk';

  if (options.modelId) {
    out[MODEL_ID] = options.modelId;
  }
  if (options.modelVersion) {
    out[MODEL_VERSION] = options.modelVersion;
  }
  if (options.sessionId) {
    out[SESSION_ID] = options.sessionId;
  }

  const inputHash = hashText(options.inputText);
  const outputHash = hashText(options.outputText);
  if (inputHash) {
    out[INPUT_HASH] = inputHash;
  }
  if (outputHash) {
    out[OUTPUT_HASH] = outputHash;
  }
  if (options.euRiskTier) {
    out[RISK_TIER] = options.euRiskTier;
  }

  const payload = `${inputHash || ''}:${outputHash || ''}:${eventType}`;
  out[INTEGRITY_HASH] = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  return out;
}
