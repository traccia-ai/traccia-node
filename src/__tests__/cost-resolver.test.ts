import { PricingRates } from '../config/pricing-config';
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

  it('matches version-suffixed model names via longest prefix', () => {
    resolver.update({
      'gpt-4o': { inputCost: 0.005, outputCost: 0.015 },
      'gpt-4': { inputCost: 0.03, outputCost: 0.06 },
    });
    expect(resolver.matchPricingModelKey('gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(resolver.compute('gpt-4o-2024-08-06', 1000, 500)).toBeDefined();
  });

  describe('Groq models (LiteLLM-shaped keys)', () => {
    // Platform snapshot entries: per-1K `prompt`/`completion` rates and a provider.
    const rates = (prompt: number, completion: number, provider: string) =>
      ({ prompt, completion, _provider: provider }) as unknown as PricingRates;

    beforeEach(() => {
      resolver.update({
        'groq/llama-3.3-70b-versatile': rates(0.00059, 0.00079, 'groq'),
        'groq/llama-3.1-8b-instant': rates(0.00005, 0.00008, 'groq'),
        'groq/openai/gpt-oss-120b': rates(0.00015, 0.0006, 'groq'),
        'groq/meta-llama/llama-4-scout-17b-16e-instruct': rates(0.00011, 0.00034, 'groq'),
        'together_ai/meta-llama/llama-4-scout-17b-16e-instruct': rates(0.00018, 0.00059, 'together_ai'),
        'fireworks_ai/accounts/fireworks/models/gemma2-9b-it': rates(0.0002, 0.0002, 'fireworks_ai'),
        'anthropic.claude-3-5-sonnet-20240620-v1:0': { inputCost: 0.003, outputCost: 0.015 },
      });
    });

    it('treats a dot in the model version as part of the name, not a provider prefix', () => {
      expect(resolver.matchPricingModelKey('llama-3.3-70b-versatile')).toBe('groq/llama-3.3-70b-versatile');
      expect(resolver.matchPricingModelKey('llama-3.1-8b-instant')).toBe('groq/llama-3.1-8b-instant');
      expect(resolver.compute('llama-3.3-70b-versatile', 1000, 1000)).toBeCloseTo(0.00138);
    });

    it('still strips a dotted provider prefix', () => {
      expect(resolver.matchPricingModelKey('claude-3-5-sonnet-20240620-v1:0')).toBe(
        'anthropic.claude-3-5-sonnet-20240620-v1:0'
      );
    });

    it("with a vendor, uses that vendor's price for a slash-containing model id", () => {
      expect(resolver.matchPricingModelKey('openai/gpt-oss-120b', 'groq')).toBe('groq/openai/gpt-oss-120b');
      expect(resolver.compute('openai/gpt-oss-120b', 1000, 1000, 0, 0, 'groq')).toBeCloseTo(0.00075);
      expect(resolver.matchPricingModelKey('meta-llama/llama-4-scout-17b-16e-instruct', 'groq')).toBe(
        'groq/meta-llama/llama-4-scout-17b-16e-instruct'
      );
    });

    it("with a vendor, never uses another provider's price", () => {
      expect(resolver.matchPricingModelKey('gemma2-9b-it')).toBe(
        'fireworks_ai/accounts/fireworks/models/gemma2-9b-it'
      );
      expect(resolver.matchPricingModelKey('gemma2-9b-it', 'groq')).toBeUndefined();
      expect(resolver.compute('gemma2-9b-it', 1000, 1000, 0, 0, 'groq')).toBeUndefined();
      expect(resolver.compute('anthropic.claude-3-5-sonnet-20240620-v1:0', 1000, 1000, 0, 0, 'groq')).toBeUndefined();
    });

    it('with a vendor, matches entries by their provider field', () => {
      resolver.update({ 'kimi-k2': rates(0.001, 0.003, 'groq') });
      expect(resolver.matchPricingModelKey('kimi-k2', 'groq')).toBe('kimi-k2');
    });

    it('with a vendor, needs the same base name, never a name prefix', () => {
      resolver.update({
        'kimi-k2': rates(0.001, 0.003, 'groq'),
        'groq/openai/gpt-oss-120b': rates(0.00015, 0.0006, 'groq'),
        'groq/openai/gpt-oss-120b-2025-08-05': rates(0.0001, 0.0005, 'groq'),
        'groq/llama-3.3-70b-versatile': rates(0.00059, 0.00079, 'groq'),
      });
      // A date suffix is not part of the base name; the exact dated key wins over the undated one.
      expect(resolver.matchPricingModelKey('openai/gpt-oss-120b-20250101', 'groq')).toBe('groq/openai/gpt-oss-120b');
      expect(resolver.matchPricingModelKey('openai/gpt-oss-120b-2025-08-05', 'groq')).toBe(
        'groq/openai/gpt-oss-120b-2025-08-05'
      );
      expect(resolver.matchPricingModelKey('kimi-k2-instruct-0905', 'groq')).toBeUndefined();
      expect(resolver.matchPricingModelKey('llama-3.3-70b-versatile-0915', 'groq')).toBeUndefined();
      expect(resolver.matchPricingModelKey('llama-3.3-70b', 'groq')).toBeUndefined();
    });

    it('prices a Groq model at the Groq key even when another provider has a shorter one', () => {
      resolver.update({
        'ovhcloud/Qwen3-32B': rates(0.00008, 0.00023, 'ovhcloud'),
        'groq/qwen/qwen3-32b': rates(0.00029, 0.00059, 'groq'),
      });
      expect(resolver.compute('qwen/qwen3-32b', 1000, 1000, 0, 0, 'groq')).toBeCloseTo(0.00088);
    });

    it('ignores a vendor that is not strict', () => {
      resolver.update({ 'kimi-k2': rates(0.001, 0.003, 'groq') });
      expect(resolver.matchPricingModelKey('kimi-k2', 'openai')).toBe('kimi-k2');
    });

    it('prices cached input at the cached rate, or the input rate without one', () => {
      resolver.update({
        'groq/openai/gpt-oss-120b': {
          ...rates(0.00015, 0.0006, 'groq'),
          cached_prompt: 0.000075,
        } as unknown as PricingRates,
        'groq/qwen/qwen3-32b': rates(0.00029, 0.00059, 'groq'),
      });
      expect(resolver.compute('openai/gpt-oss-120b', 200, 0, 800, 0, 'groq')).toBeCloseTo(0.00003 + 0.00006);
      expect(resolver.computeDetailed('qwen/qwen3-32b', 200, 0, 800, 0, 'groq')).toEqual({
        cost: expect.closeTo(0.00029),
        cacheFallback: true,
      });
    });
  });
});
