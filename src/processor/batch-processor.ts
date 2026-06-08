/**
 * Batch span processor with queue management and background flush.
 */

import { ISpan, ISpanProcessor, ISpanExporter } from '../types';
import { ISampler } from '../types';

const DEFAULT_MAX_QUEUE_SIZE = 5000;
const DEFAULT_MAX_EXPORT_BATCH_SIZE = 512;
const DEFAULT_SCHEDULE_DELAY_MS = 5000;

/**
 * Drop policy for handling queue overflow.
 */
export enum DropPolicy {
  DROP_OLDEST = 'drop_oldest',
  DROP_NEWEST = 'drop_newest',
}

/**
 * Batch span processor.
 */
export class BatchSpanProcessor implements ISpanProcessor {
  private exporter?: ISpanExporter;
  private maxQueueSize: number;
  private maxExportBatchSize: number;
  private scheduleDelayMs: number;
  private dropPolicy: DropPolicy;
  private sampler?: ISampler;

  private queue: ISpan[] = [];
  private _shutdown = false;
  private timer?: NodeJS.Timeout;
  private processing = false;

  constructor(options: {
    exporter?: ISpanExporter;
    maxQueueSize?: number;
    maxExportBatchSize?: number;
    scheduleDelayMs?: number;
    dropPolicy?: DropPolicy;
    sampler?: ISampler;
  } = {}) {
    this.exporter = options.exporter;
    this.maxQueueSize = options.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE;
    this.maxExportBatchSize = options.maxExportBatchSize || DEFAULT_MAX_EXPORT_BATCH_SIZE;
    this.scheduleDelayMs = options.scheduleDelayMs || DEFAULT_SCHEDULE_DELAY_MS;
    this.dropPolicy = options.dropPolicy || DropPolicy.DROP_OLDEST;
    this.sampler = options.sampler;

    this.startSchedule();
  }

  /**
   * Handle span end.
   */
  onEnd(span: ISpan): void {
    if (this._shutdown) {
      return;
    }

    // Apply head-based sampling: drop non-sampled traces
    if (this.sampler && span.context.traceFlags === 0) {
      return;
    }

    this.enqueue(span);
  }

  /**
   * Force flush pending spans.
   */
  async forceFlush(timeout?: number): Promise<void> {
    const deadline = timeout ? Date.now() + timeout : undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const flushed = await this.flushOnce(deadline);
      if (!flushed || (deadline && Date.now() >= deadline)) {
        break;
      }
    }
  }

  /**
   * Shutdown the processor.
   */
  async shutdown(): Promise<void> {
    this._shutdown = true;
    if (this.timer) {
      if (this.timer) {
        clearInterval(this.timer);
      }
    }
    await this.forceFlush();
    if (this.exporter) {
      await this.exporter.shutdown();
    }
  }

  /**
   * Enqueue a span.
   */
  private enqueue(span: ISpan): void {
    if (this.queue.length >= this.maxQueueSize) {
      if (this.dropPolicy === DropPolicy.DROP_OLDEST) {
        this.queue.shift();
      } else {
        return; // Drop newest
      }
    }
    this.queue.push(span);
  }

  /**
   * Flush once (export one batch).
   */
  private async flushOnce(deadline?: number): Promise<boolean> {
    if (this.processing) {
      return false;
    }

    if (deadline && Date.now() >= deadline) {
      return false;
    }

    const batch = this.drainQueue(this.maxExportBatchSize);
    if (batch.length === 0) {
      return false;
    }

    await this.export(batch);
    return true;
  }

  /**
   * Drain queue.
   */
  private drainQueue(limit: number): ISpan[] {
    const batch: ISpan[] = [];
    while (batch.length < limit && this.queue.length > 0) {
      const span = this.queue.shift();
      if (span) {
        batch.push(span);
      }
    }
    return batch;
  }

  /**
   * Export spans.
   */
  private async export(spans: ISpan[]): Promise<void> {
    if (!this.exporter) {
      return;
    }

    this.processing = true;
    try {
      await this.exporter.export(spans);
    } catch {
      // Export errors are swallowed for resilience
    } finally {
      this.processing = false;
    }
  }

  /**
   * Start the background scheduling.
   */
  private startSchedule(): void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.timer = setInterval(async () => {
      await this.flushOnce();
    }, this.scheduleDelayMs);

    // Ensure the timer doesn't keep the process alive
    if (this.timer.unref) {
      this.timer.unref();
    }
  }
}
