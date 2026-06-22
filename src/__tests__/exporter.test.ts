/**
 * Tests for exporters.
 */

import { HttpExporter } from '../exporter/http-exporter';
import { ConsoleExporter } from '../exporter/console-exporter';
import { FileExporter } from '../exporter/file-exporter';
import { TracerProvider } from '../tracer/provider';
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
});
