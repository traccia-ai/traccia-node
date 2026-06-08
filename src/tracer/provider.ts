/**
 * Tracer provider for managing tracers and span processors.
 */

import { randomBytes } from 'crypto';
import { ITracerProvider, ITracer, ISpanProcessor, ISampler, ISpan, Resource } from '../types';
import { Tracer } from './tracer';

/**
 * TracerProvider manages tracers and span processors.
 */
export class TracerProvider implements ITracerProvider {
  private tracers: Map<string, Tracer> = new Map();
  private spanProcessors: ISpanProcessor[] = [];
  private sampler?: ISampler;
  private resource: Resource = {};

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
   * Set the sampler.
   */
  setSampler(sampler: ISampler): void {
    this.sampler = sampler;
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
