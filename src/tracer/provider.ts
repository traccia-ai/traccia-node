/**
 * Tracer provider for managing tracers and span processors.
 */

import { randomBytes } from 'crypto';
import {
  BasicTracerProvider,
  ParentBasedSampler,
  Sampler as OTelSampler,
  SamplingDecision,
} from '@opentelemetry/sdk-trace-base';
import { ITracerProvider, ITracer, ISpanProcessor, ISampler, ISpan, Resource } from '../types';
import { SwitchableSampler, defaultOtelSampler } from '../processor/sampler';
import { Tracer } from './tracer';

/**
 * Turn a Traccia sampler into the OTel sampler applied at span creation.
 * Custom ISampler implementations decide roots; children follow their parent.
 */
function toOtelSampler(sampler: ISampler): OTelSampler {
  const withOtel = sampler as ISampler & { toOtelSampler?: () => OTelSampler };
  if (typeof withOtel.toOtelSampler === 'function') {
    return withOtel.toOtelSampler();
  }
  return new ParentBasedSampler({
    root: {
      shouldSample: () => ({
        decision: sampler.shouldSample().sampled
          ? SamplingDecision.RECORD_AND_SAMPLED
          : SamplingDecision.NOT_RECORD,
      }),
      toString: () => 'TracciaSampler',
    },
  });
}

/**
 * TracerProvider manages tracers and span processors.
 */
export class TracerProvider implements ITracerProvider {
  private tracers: Map<string, Tracer> = new Map();
  private spanProcessors: ISpanProcessor[] = [];
  private sampler?: ISampler;
  private resource: Resource = {};
  private readonly samplerSwitch = new SwitchableSampler();
  private readonly otelProvider = new BasicTracerProvider({ sampler: this.samplerSwitch });

  constructor(resource?: Resource) {
    this.resource = resource || {};
    // Set default SDK and service metadata if not present
    if (!this.resource['sdk.name']) this.resource['sdk.name'] = 'traccia-sdk-ts';
    if (!this.resource['sdk.version']) this.resource['sdk.version'] = '1.0.0';
    if (!this.resource['service.name']) this.resource['service.name'] = 'unknown-service';
    if (!this.resource['service.version']) this.resource['service.version'] = 'unknown';
  }

  /**
   * Get or create a tracer.
   */
  getTracer(name: string, version?: string): ITracer {
    const key = version ? `${name}@${version}` : name;
    let tracer = this.tracers.get(key);

    if (!tracer) {
      tracer = new Tracer(this, key);
      this.tracers.set(key, tracer);
    }

    return tracer;
  }

  /**
   * Add a span processor.
   */
  addSpanProcessor(processor: ISpanProcessor): void {
    this.spanProcessors.push(processor);
  }

  /**
   * Remove a span processor.
   */
  removeSpanProcessor(processor: ISpanProcessor): void {
    const index = this.spanProcessors.indexOf(processor);
    if (index > -1) {
      this.spanProcessors.splice(index, 1);
    }
  }

  /**
   * Set the sampler and apply it at span creation.
   *
   * Takes effect for every span started after this call, including spans from
   * tracers created earlier. Child spans follow their parent's decision, so
   * unsampled traces get traceFlags 0 and export processors drop them.
   * Pass undefined to restore the default (parent-based, always on).
   */
  setSampler(sampler: ISampler | undefined): void {
    this.sampler = sampler;
    this.samplerSwitch.delegate = sampler ? toOtelSampler(sampler) : defaultOtelSampler();
  }

  /**
   * The OTel provider that creates this provider's spans.
   */
  getOtelTracerProvider(): BasicTracerProvider {
    return this.otelProvider;
  }

  /**
   * Get the sampler.
   */
  getSampler(): ISampler | undefined {
    return this.sampler;
  }

  /**
   * Notify all processors that a span has ended.
   */
  notifySpanEnd(span: ISpan): void {
    for (const processor of this.spanProcessors) {
      try {
        processor.onEnd(span);
      } catch {
        // Processors should not crash the tracing system
        // Errors are silently swallowed for resilience
      }
    }
  }

  /**
   * Force flush all processors.
   */
  async forceFlush(timeout?: number): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const processor of this.spanProcessors) {
      const promise = Promise.resolve(processor.forceFlush(timeout));
      promises.push(promise);
    }

    await Promise.all(promises);
  }

  /**
   * Shutdown all processors.
   */
  async shutdown(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const processor of this.spanProcessors) {
      const promise = Promise.resolve(processor.shutdown());
      promises.push(promise);
    }

    await Promise.all(promises);
  }

  /**
   * Generate a random trace ID.
   */
  generateTraceId(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Generate a random span ID.
   */
  generateSpanId(): string {
    return randomBytes(8).toString('hex');
  }

  /**
   * Get the resource attributes.
   */
  getResource(): Resource {
    return this.resource;
  }
}
