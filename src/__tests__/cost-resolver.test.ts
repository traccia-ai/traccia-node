import { getResolver, CostResolver } from '../processor/cost-resolver';

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

  it('should dynamically update pricing tables', () => {
    resolver.update({
      'gpt-4': { inputCost: 0.01, outputCost: 0.02 } // Updated price
    });

    const cost = resolver.compute('gpt-4', 1000, 500);
    // 1000 * 0.01/1000 + 500 * 0.02/1000 = 0.01 + 0.01 = 0.02
    expect(cost).toBeCloseTo(0.02);
  });

  it('should maintain singleton instance', () => {
    const r1 = getResolver();
    const r2 = getResolver();
    expect(r1).toBe(r2);
  });
});
