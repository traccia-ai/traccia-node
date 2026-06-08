/**
 * Custom exporter example.
 */

import { ISpanExporter, ISpan, SpanStatus } from '../dist/index';

/**
 * File-based exporter example.
 */
export class FileExporter implements ISpanExporter {
  private filePath: string;
  private spans: ISpan[] = [];

  constructor(filePath: string = 'spans.jsonl') {
    this.filePath = filePath;
  }

  /**
   * Export spans to file.
   */
  async export(spans: ISpan[]): Promise<boolean> {
    try {
      const fs = require('fs').promises;

      for (const span of spans) {
        const line = JSON.stringify({
          traceId: span.context.traceId,
          spanId: span.context.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          startTimeNs: span.startTimeNs,
          endTimeNs: span.endTimeNs,
          durationNs: span.durationNs,
          attributes: span.attributes,
          status: span.status,
        });

        await fs.appendFile(this.filePath, line + '\n');
        this.spans.push(span);
      }

      return true;
    } catch (error) {
      console.error('Failed to export spans:', error);
      return false;
    }
  }

  /**
   * Shutdown the exporter.
   */
  async shutdown(): Promise<void> {
    console.log(`Exported ${this.spans.length} spans to ${this.filePath}`);
  }
}

/**
 * Redis-based exporter example.
 */
export class RedisExporter implements ISpanExporter {
  private redisClient: any;
  private key: string;

  constructor(redisClient: any, key: string = 'traccia:spans') {
    this.redisClient = redisClient;
    this.key = key;
  }

  /**
   * Export spans to Redis.
   */
  async export(spans: ISpan[]): Promise<boolean> {
    try {
      for (const span of spans) {
        const serialized = JSON.stringify({
          traceId: span.context.traceId,
          spanId: span.context.spanId,
          name: span.name,
          startTimeNs: span.startTimeNs,
          endTimeNs: span.endTimeNs,
          attributes: span.attributes,
        });

        await this.redisClient.rpush(this.key, serialized);
      }

      return true;
    } catch (error) {
      console.error('Failed to export spans to Redis:', error);
      return false;
    }
  }

  /**
   * Shutdown the exporter.
   */
  async shutdown(): Promise<void> {
    // Redis client cleanup if needed
  }
}

/**
 * Custom processor example: error tracking.
 */
export class ErrorTrackingProcessor {
  private errors: Array<{
    spanName: string;
    error: string;
    timestamp: number;
  }> = [];

  onEnd(span: ISpan): void {
    if (span.status === SpanStatus.ERROR) {
      this.errors.push({
        spanName: span.name,
        error: span.statusDescription || 'Unknown error',
        timestamp: Date.now(),
      });
    }
  }

  async shutdown(): Promise<void> {
    console.log('Errors tracked:', this.errors);
  }

  async forceFlush(): Promise<void> {}

  getErrors() {
    return this.errors;
  }
}

/**
 * Example: Using FileExporter to export spans to a file.
 */
async function exampleFileExporter() {
  const { startTracing, getTracer, stopTracing, getTracerProvider } = await import('../dist/index');

  console.log('Starting tracing with FileExporter...');
  
  // Create file exporter
  const fileExporter = new FileExporter('example-spans.jsonl');
  
  await startTracing({
    sessionId: 'file-export-example',
    enableConsoleExporter: false,
  });

  const tracer = getTracer('file-exporter-example');

  // Create some spans
  const span1 = tracer.startSpan('operation-1', {
    attributes: { type: 'file-export' },
  });
  await new Promise((r) => setTimeout(r, 50));
  span1.end();

  const span2 = tracer.startSpan('operation-2', {
    attributes: { status: 'success' },
  });
  await new Promise((r) => setTimeout(r, 100));
  span2.end();

  // Force flush to export
  const provider = getTracerProvider();
  await provider.forceFlush(5000);

  // Export to file
  console.log('\nExporting spans to file...');
  await fileExporter.export([span1, span2]);
  await fileExporter.shutdown();

  await stopTracing();

  console.log('\n✅ Spans exported to: example-spans.jsonl');
  console.log('   Location: ' + process.cwd() + '/example-spans.jsonl');
}

// Run if executed directly
if (require.main === module) {
  exampleFileExporter().catch(console.error);
}
