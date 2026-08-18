/**
 * Tests for exporters.
 */

import { HttpExporter } from '../exporter/http-exporter';
import { ConsoleExporter } from '../exporter/console-exporter';
import { FileExporter } from '../exporter/file-exporter';
import { TracerProvider } from '../tracer/provider';
import { SpanStatus } from '../types';
import {
  setSessionId,
  setUserId,
  setTenantId,
  setProjectId,
  setDebug,
  setAttrTruncationLimit,
} from '../config/runtime-config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('HttpExporter', () => {
  it('should create with options', () => {
    const exporter = new HttpExporter({
      endpoint: 'https://example.com/traces',
      apiKey: 'test-key',
    });

    expect(exporter).toBeDefined();
  });

  it.skip('should serialize spans', async () => {
    const exporter = new HttpExporter({
      endpoint: 'http://localhost:9999', // Non-existent endpoint
    });
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span', {
      attributes: { key: 'value' },
    });

    span.end();

    const result = await exporter.export([span]);
    // Result depends on endpoint availability
    expect(typeof result).toBe('boolean');
  });

  it('should handle shutdown', async () => {
    const exporter = new HttpExporter();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });
});

describe('ConsoleExporter', () => {
  it('should export spans to console', async () => {
    const exporter = new ConsoleExporter();
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span');

    span.end();

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    await exporter.export([span]);

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should handle shutdown', async () => {
    const exporter = new ConsoleExporter();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });
});

describe('FileExporter', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traccia-tests-'));
    filePath = path.join(tmpDir, 'test-traces.jsonl');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should export spans to file sequentially', async () => {
    const exporter = new FileExporter({ filePath });
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    
    const span1 = tracer.startSpan('span1');
    span1.end();
    const span2 = tracer.startSpan('span2');
    span2.end();

    // Export concurrently to test concurrency safety
    await Promise.all([
      exporter.export([span1]),
      exporter.export([span2])
    ]);

    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.trim().split('\n');
    expect(lines).toHaveLength(2);
    
    expect(JSON.parse(lines[0]).scopeSpans).toBeDefined();
    expect(JSON.parse(lines[1]).scopeSpans).toBeDefined();
  });

  it('returns true immediately without writing when spans is empty', async () => {
    const exporter = new FileExporter({ filePath });

    const result = await exporter.export([]);

    expect(result).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('truncates (not appends) the file on the first export when resetOnStart is true', async () => {
    fs.writeFileSync(filePath, 'stale content\n', 'utf-8');
    const exporter = new FileExporter({ filePath, resetOnStart: true });
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('span1');
    span.end();

    await exporter.export([span]);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).not.toContain('stale content');
    expect(content.trim().split('\n')).toHaveLength(1);
  });

  it('appends (does not re-truncate) on the second export even with resetOnStart true', async () => {
    const exporter = new FileExporter({ filePath, resetOnStart: true });
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span1 = tracer.startSpan('span1');
    span1.end();
    const span2 = tracer.startSpan('span2');
    span2.end();

    await exporter.export([span1]);
    await exporter.export([span2]);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content.trim().split('\n')).toHaveLength(2);
  });

  it('returns false and logs when the write fails', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // A directory path that does not exist makes appendFile reject.
    const badPath = path.join(tmpDir, 'nonexistent-dir', 'traces.jsonl');
    const exporter = new FileExporter({ filePath: badPath });
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('span1');
    span.end();

    const result = await exporter.export([span]);

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith('[FileExporter] Failed to write spans:', expect.anything());
    errorSpy.mockRestore();
  });

  it('shutdown() waits for a pending write to complete', async () => {
    const exporter = new FileExporter({ filePath });
    const provider = new TracerProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('span1');
    span.end();

    const exportPromise = exporter.export([span]);
    await exporter.shutdown();
    await exportPromise;

    expect(fs.readFileSync(filePath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  describe('serialize()', () => {
    afterEach(() => {
      setSessionId(undefined);
      setUserId(undefined);
      setTenantId(undefined);
      setProjectId(undefined);
      setDebug(false);
      setAttrTruncationLimit(undefined);
    });

    it('includes conditional resource attributes when set on the runtime config', async () => {
      setSessionId('session-1');
      setUserId('user-1');
      setTenantId('tenant-1');
      setProjectId('project-1');
      setDebug(true);

      const exporter = new FileExporter({ filePath });
      const provider = new TracerProvider();
      const tracer = provider.getTracer('test');
      const span = tracer.startSpan('span1');
      span.end();

      await exporter.export([span]);

      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
      expect(payload.resource.attributes).toMatchObject({
        'session.id': 'session-1',
        'user.id': 'user-1',
        'tenant.id': 'tenant-1',
        'project.id': 'project-1',
        'trace.debug': true,
      });
    });

    it('omits resource attributes entirely when none are configured', async () => {
      const exporter = new FileExporter({ filePath });
      const provider = new TracerProvider();
      const tracer = provider.getTracer('test');
      const span = tracer.startSpan('span1');
      span.end();

      await exporter.export([span]);

      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
      expect(payload.resource.attributes).toEqual({});
    });

    it('truncates long string attributes to attrTruncationLimit', async () => {
      setAttrTruncationLimit(10);

      const exporter = new FileExporter({ filePath });
      const provider = new TracerProvider();
      const tracer = provider.getTracer('test');
      const span = tracer.startSpan('span1', { attributes: { long: 'a'.repeat(50) } });
      span.end();

      await exporter.export([span]);

      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
      const value = payload.scopeSpans[0].spans[0].attributes.long as string;
      expect(value.length).toBe(10);
      expect(value.endsWith('…')).toBe(true);
    });

    it('truncates recursively nested objects past depth 6 to a string', async () => {
      let nested: any = 'leaf';
      for (let i = 0; i < 8; i++) {
        nested = { child: nested };
      }

      const exporter = new FileExporter({ filePath });
      const provider = new TracerProvider();
      const tracer = provider.getTracer('test');
      const span = tracer.startSpan('span1', { attributes: { deep: nested } });
      span.end();

      await exporter.export([span]);

      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
      // Walk down until we hit a string instead of a further-nested object.
      let cursor = payload.scopeSpans[0].spans[0].attributes.deep;
      let depth = 0;
      while (cursor && typeof cursor === 'object' && 'child' in cursor && depth < 10) {
        cursor = cursor.child;
        depth += 1;
      }
      expect(typeof cursor).toBe('string');
    });

    it('slices arrays to a maximum of 100 items', async () => {
      const bigArray = Array.from({ length: 150 }, (_, i) => i);

      const exporter = new FileExporter({ filePath });
      const provider = new TracerProvider();
      const tracer = provider.getTracer('test');
      const span = tracer.startSpan('span1', { attributes: { items: bigArray } });
      span.end();

      await exporter.export([span]);

      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
      expect(payload.scopeSpans[0].spans[0].attributes.items).toHaveLength(100);
    });

    it('maps span status ERROR/UNSET to the corresponding OTLP status code', async () => {
      const exporter = new FileExporter({ filePath });
      const provider = new TracerProvider();
      const tracer = provider.getTracer('test');

      const errorSpan = tracer.startSpan('error-span');
      errorSpan.status = SpanStatus.ERROR;
      errorSpan.statusDescription = 'boom';
      errorSpan.end();

      const unsetSpan = tracer.startSpan('unset-span');
      unsetSpan.end();

      await exporter.export([errorSpan, unsetSpan]);

      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
      const [errorOut, unsetOut] = payload.scopeSpans[0].spans;
      expect(errorOut.status).toEqual({ code: 2, message: 'boom' });
      expect(unsetOut.status).toEqual({ code: 0, message: '' });
    });
  });
});
