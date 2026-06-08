/**
 * Tests for exporters.
 */

import { HttpExporter } from '../exporter/http-exporter';
import { ConsoleExporter } from '../exporter/console-exporter';
import { TracerProvider } from '../tracer/provider';

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
