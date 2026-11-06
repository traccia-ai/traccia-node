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

  private queue: ISpan[] = [];
  private _shutdown = false;
  private timer?: NodeJS.Timeout;
  private inFlight: Promise<void> | null = null;

  constructor(options: {
    exporter?: ISpanExporter;
    maxQueueSize?: number;
    maxExportBatchSize?: number;
    scheduleDelayMs?: number;
    dropPolicy?: DropPolicy;
    /** @deprecated Ignored. Sampling is applied at span creation (TracerProvider.setSampler) and unsampled spans are always dropped. */
    sampler?: ISampler;
  } = {}) {
    this.exporter = options.exporter;
    this.maxQueueSize = options.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE;
    this.maxExportBatchSize = options.maxExportBatchSize || DEFAULT_MAX_EXPORT_BATCH_SIZE;
    this.scheduleDelayMs = options.scheduleDelayMs || DEFAULT_SCHEDULE_DELAY_MS;
    this.dropPolicy = options.dropPolicy || DropPolicy.DROP_OLDEST;

    this.startSchedule();
  }

  /**
   * Handle span end.
   */
  onEnd(span: ISpan): void {
    if (this._shutdown) {
      return;
    }

    // Head sampling is decided at span creation and recorded as traceFlags 0.
    // Drop those spans whether or not this processor was given a sampler.
    if (span.context.traceFlags === 0) {
      return;
    }

    this.enqueue(span);
  }

  /**
   * Force flush pending spans. Keeps draining the queue and waiting for the
   * export chain (including an export the background timer already started,
   * whose spans are no longer in the queue) until both are empty or the
   * deadline is exceeded.
   */
  async forceFlush(timeout?: number): Promise<void> {
    const deadline = timeout ? Date.now() + timeout : undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (deadline && Date.now() >= deadline) {
        return;
      }

      if (this.queue.length > 0) {
        if (!(await this.untilDeadline(this.flushOnce(deadline), deadline))) {
          return;
        }
        continue;
      }

      const pending = this.inFlight;
      if (pending === null) {
        return;
      }
      if (!(await this.untilDeadline(pending, deadline))) {
        return;
      }
      // `pending` has settled, but export() may not have cleared inFlight
      // yet. If nothing newer chained on and the queue is still empty,
      // everything is drained.
      if (this.inFlight === pending && this.queue.length === 0) {
        return;
      }
    }
  }

  /**
   * Shutdown the processor. Fully drains the queue before tearing down the
   * background timer/exporter, so spans enqueued right before shutdown are
   * not stranded.
   */
  async shutdown(): Promise<void> {
    this._shutdown = true;
    await this.forceFlush();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.exporter) {
      await this.exporter.shutdown();
    }
  }

  /**
   * Await `work`, giving up once the deadline passes. Resolves true if
   * `work` settled in time. The work itself is not cancelled.
   */
  private async untilDeadline(work: Promise<unknown>, deadline?: number): Promise<boolean> {
    if (!deadline) {
      await work;
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), remaining);
    });
    try {
      return await Promise.race([work.then(() => true), expired]);
    } finally {
      clearTimeout(timer);
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
   * Flush once (export one batch). Draining the queue is synchronous, so
   * concurrent callers (the background timer and an explicit forceFlush)
   * never grab the same spans twice; the actual export call is serialized
   * via `this.inFlight` so exports still run one at a time.
   */
  private async flushOnce(deadline?: number): Promise<boolean> {
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
   * Export spans. Chained onto `this.inFlight` so overlapping calls (e.g.
   * the background timer firing while forceFlush is draining) run their
   * exporter.export() calls one at a time instead of racing.
   */
  private async export(spans: ISpan[]): Promise<void> {
    if (!this.exporter) {
      return;
    }

    const previous = this.inFlight ?? Promise.resolve();

    const run = previous
      .catch(() => {
        // Ignore failures from the previous export in the chain; each
        // export's own errors are handled below.
      })
      .then(async () => {
        try {
          await this.exporter!.export(spans);
        } catch {
          // Export errors are swallowed for resilience
        }
      });

    this.inFlight = run;
    await run;

    // Only clear inFlight if nothing newer has chained on since.
    if (this.inFlight === run) {
      this.inFlight = null;
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
