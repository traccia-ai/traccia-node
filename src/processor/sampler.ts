/**
 * Sampler for making sampling decisions.
 */

import { Context, Link, SpanKind, Attributes } from '@opentelemetry/api';
import {
  AlwaysOnSampler,
  ParentBasedSampler,
  Sampler as OTelSampler,
  SamplingResult as OTelSamplingResult,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { ISampler, SamplingResult } from '../types';
import { ConfigError } from '../errors';

/**
 * Probability-based sampler.
 */
export class Sampler implements ISampler {
  private sampleRate: number;

  constructor(sampleRate: number = 1.0) {
    if (sampleRate < 0 || sampleRate > 1.0) {
      throw new ConfigError('sampleRate must be between 0.0 and 1.0');
    }
    this.sampleRate = sampleRate;
  }

  /**
   * Decide whether to sample.
   */
  shouldSample(): SamplingResult {
    // Math.random() returns values in [0, 1), so a strict comparison keeps
    // rate 0 at never and rate 1 at always.
    return {
      sampled: Math.random() < this.sampleRate,
    };
  }

  /**
   * Get the current sample rate.
   */
  getSampleRate(): number {
    return this.sampleRate;
  }

  /**
   * Build the OpenTelemetry sampler that applies this rate at span creation.
   *
   * Root spans are sampled by trace ID ratio. Child spans follow their
   * parent's decision, so a trace is exported whole or not at all.
   */
  toOtelSampler(): OTelSampler {
    return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(this.sampleRate) });
  }
}

/**
 * OTel's default: parent-based, always on for roots.
 */
export function defaultOtelSampler(): OTelSampler {
  return new ParentBasedSampler({ root: new AlwaysOnSampler() });
}

/**
 * OTel sampler that forwards to a replaceable delegate.
 *
 * OTel tracers capture the provider's sampler when they are created, so
 * installing this once and swapping its delegate changes sampling for every
 * tracer, including ones created before the sampler was set.
 */
export class SwitchableSampler implements OTelSampler {
  constructor(public delegate: OTelSampler = defaultOtelSampler()) {}

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): OTelSamplingResult {
    return this.delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return this.delegate.toString();
  }
}
