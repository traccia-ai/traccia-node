import { getResolver, CostResolver, setResolver } from '../processor/cost-resolver';

describe('CostResolver', () => {
  let resolver: CostResolver;

  beforeEach(() => {
    resolver = getResolver();
    // Reset pricing
    resolver.update({
      'gpt-4': { inputCost: 0.03, outputCost: 0.06 },
      'gpt-3.5-turbo': { inputCost: 0.0015, outputCost: 0.002 }
    });
  });

  afterEach(() => {
    // Reset singleton
    setResolver(new CostResolver({}, 'bundled', 'unknown'));
  });

  it('should resolve cost correctly for known models', () => {
    const cost = resolver.compute('gpt-4', 1000, 500);
    // 1000 * 0.03/1000 + 500 * 0.06/1000 = 0.03 + 0.03 = 0.06
    expect(cost).toBeCloseTo(0.06);
  });

  it('should resolve cost for missing usage', () => {
    const cost = resolver.compute('gpt-4', 0, 500);
    // 0 + 500 * 0.06/1000 = 0.03
    expect(cost).toBeCloseTo(0.03);
  });

  it('should return undefined for unknown models', () => {
    const cost = resolver.compute('unknown-model', 1000, 1000);
    expect(cost).toBeUndefined();
  });

  it('prices cache read and write separately from uncached input', () => {
    resolver.update({
      'grok-4.6': { inputCost: 0.002, outputCost: 0.01, cacheReadCost: 0.0002, cacheWriteCost: 0.0025 },
    });
    const detailed = resolver.computeDetailed('grok-4.6', 100, 20, 800, 100);
    expect(detailed?.cacheFallback).toBe(false);
    expect(detailed?.cost).toBeCloseTo(0.0002 + 0.0002 + 0.00016 + 0.00025);
  });

  it('falls back to the input rate when cache prices are missing', () => {
    const detailed = resolver.computeDetailed('gpt-4', 0, 0, 1000, 0);
    expect(detailed?.cacheFallback).toBe(true);
    expect(detailed?.cost).toBeCloseTo(0.03);
  });

  it('matches grok-4.7 to xai/grok-4.7 and not grok-4', () => {
    resolver.update({
      'xai/grok-4.7': { inputCost: 0.002, outputCost: 0.01, cacheReadCost: 0.0002 },
      'openrouter/x-ai/grok-4.7': { inputCost: 9, outputCost: 9 },
      'grok-4': { inputCost: 0.001, outputCost: 0.001 },
    });
    expect(resolver.matchPricingModelKey('grok-4.7')).toBe('xai/grok-4.7');
    const detailed = resolver.computeDetailed('grok-4.7', 1000, 0);
    expect(detailed?.cost).toBeCloseTo(0.002);
  });

  it('should dynamically update pricing tables', () => {
    resolver.update(
      { 'gpt-4': { inputCost: 0.01, outputCost: 0.02 } },
      'remote',
      '2024'
    );

    const cost = resolver.compute('gpt-4', 1000, 500);
    expect(cost).toBeCloseTo(0.02);

    expect(resolver.getSource).toBe('remote');
    expect(resolver.getGeneratedAt).toBe('2024');
  });

  it('should maintain singleton instance', () => {
    const r1 = getResolver();
    const r2 = getResolver();
    expect(r1).toBe(r2);
  });

  it('should support snapshot', () => {
    resolver.update({ 'gpt-test': { inputCost: 1, outputCost: 2 } }, 'custom', 'time');
    const snap = resolver.snapshot();
    expect(snap.table).toHaveProperty('gpt-test');
    expect(snap.source).toBe('custom');
    expect(snap.generatedAt).toBe('time');
  });

  it('should allow getters', () => {
    const r = new CostResolver({}, 'test-source', 'test-time');
    expect(r.pricingTable).toEqual({});
    expect(r.getSource).toBe('test-source');
    expect(r.getGeneratedAt).toBe('test-time');
  });

  it('matches dated model names by base name', () => {
    resolver.update({
      'gpt-4o': { inputCost: 0.005, outputCost: 0.015 },
      'gpt-4': { inputCost: 0.03, outputCost: 0.06 },
    });
    expect(resolver.matchPricingModelKey('gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(resolver.compute('gpt-4o-2024-08-06', 1000, 500)).toBeDefined();
  });
});
