/**
 * Type guard for OTLP status object.
 */
function isOtelStatus(obj: any): obj is { code: any } {
  return obj !== null && obj !== undefined && typeof obj === 'object' && 'code' in obj;
}
/**
 * HTTP Exporter for sending spans to a backend service.
 */


import * as https from 'https';
import * as http from 'http';
import { ISpan, ISpanExporter } from '../types';
import { version as tracciaVersion } from '../../package.json';

export const DEFAULT_ENDPOINT = 'https://api.dashboard.com/api/v1/traces';

const TRANSIENT_STATUS_CODES = new Set([429, 503, 504]);

/**
 * HTTP Exporter configuration.
 */
export interface HttpExporterOptions {
  endpoint?: string;
  apiKey?: string;
  timeout?: number;
  maxRetries?: number;
  backoffBase?: number;
  backoffJitter?: number;
}

/**
 * HTTP Exporter for sending spans to a backend.
 */
export class HttpExporter implements ISpanExporter {
  private endpoint: string;
  private apiKey?: string;
  private timeout: number;
  private maxRetries: number;
  private backoffBase: number;
  private backoffJitter: number;

  constructor(options: HttpExporterOptions = {}) {
    this.endpoint = options.endpoint || DEFAULT_ENDPOINT;
    this.apiKey = options.apiKey;
    this.timeout = options.timeout || 10000;
    this.maxRetries = options.maxRetries || 5;
    this.backoffBase = options.backoffBase || 1;
    this.backoffJitter = options.backoffJitter || 0.5;
  }

  /**
   * Export spans to the backend.
   */
  async export(spans: ISpan[]): Promise<boolean> {
    if (spans.length === 0) {
      return true;
    }

    const payload = this.serializeSpans(spans);
    const headers = this.getHeaders();

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const status = await this.sendRequest(payload, headers);

        if (status >= 200 && status < 300) {
          return true;
        }

        if (!TRANSIENT_STATUS_CODES.has(status)) {
          return false;
        }

        const backoff = this.computeBackoff(attempt);
        await this.sleep(backoff);
      } catch {
        // Treat transport errors as transient
        if (attempt < this.maxRetries - 1) {
          const backoff = this.computeBackoff(attempt);
          await this.sleep(backoff);
        }
      }
    }

    return false;
  }

  /**
   * Shutdown the exporter.
   */
  async shutdown(): Promise<void> {
    // No-op for HTTP exporter
  }

  /**
   * Serialize spans to JSON bytes in OpenTelemetry-like format.
   */
  private serializeSpans(spans: ISpan[]): string {
    // Group all spans under a single scope for now
    const scope = {
      name: 'traccia-sdk-ts',
      version: tracciaVersion,
    };

    const otelSpans = spans.map((span) => {
      const status = span.status;
      let otelStatus;
      if (isOtelStatus(status)) {
        otelStatus = status;
      } else {
        otelStatus = { code: this.statusToString(status ?? 0), message: span.statusDescription || '' };
      }
      return {
        traceId: span.context.traceId,
        spanId: span.context.spanId,
        parentSpanId: span.parentSpanId ?? null,
        name: span.name,
        startTimeUnixNano: span.startTimeNs,
        endTimeUnixNano: span.endTimeNs,
        attributes: span.attributes,
        events: span.events || [],
        status: otelStatus,
      };
    });

    const payload = {
      items: [
        {
          scopeSpans: [
            {
              scope,
              spans: otelSpans,
            },
          ],
        },
      ],
    };

    return JSON.stringify(payload);
  }

  /**
   * Convert numeric status to string code for OTLP compatibility.
   */
  private statusToString(status: any): string {
    switch (status) {
      case 0:
        return 'UNSET';
      case 1:
        return 'OK';
      case 2:
        return 'ERROR';
      default:
        return 'UNSET';
    }
  }

  /**
   * Get request headers.
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'traccia-sdk-ts/1.0.0',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  /**
   * Send HTTP request.
   */
  private sendRequest(payload: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.endpoint);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: this.timeout,
      };

      const request = client.request(options, (response) => {
        response.on('data', () => {
          // Consume data but don't store
        });

        response.on('end', () => {
          resolve(response.statusCode || 500);
        });
      });

      request.on('error', (error) => {
        reject(error);
      });

      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });

      request.write(payload);
      request.end();
    });
  }

  /**
   * Compute exponential backoff with jitter.
   */
  private computeBackoff(attempt: number): number {
    const exponential = this.backoffBase * Math.pow(2, attempt);
    const jitter = Math.random() * this.backoffJitter;
    return (exponential + jitter) * 1000;
  }

  /**
   * Sleep for a given number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
