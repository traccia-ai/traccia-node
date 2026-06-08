/**
 * Sampler for making sampling decisions.
 */

import { ISampler, SamplingResult } from '../types';

/**
 * Probability-based sampler.
 */
export class Sampler implements ISampler {
  private sampleRate: number;

  constructor(sampleRate: number = 1.0) {
    if (sampleRate < 0 || sampleRate > 1) {
      throw new Error('sampleRate must be between 0.0 and 1.0');
    }
    this.sampleRate = sampleRate;
  }

  /**
   * Decide whether to sample.
   */
  shouldSample(): SamplingResult {
    return {
      sampled: Math.random() <= this.sampleRate,
    };
  }

  /**
   * Get the current sample rate.
   */
  getSampleRate(): number {
    return this.sampleRate;
  }
}
