import { describe, it, expect } from 'vitest';
import { movingAverage, dailyVolatility, recentSwingLow } from './price-series';

describe('movingAverage', () => {
  it('averages the most recent n closes (closes are newest-first)', () => {
    // newest-first: [10, 20, 30, 40]; MA of last 2 = (10+20)/2 = 15
    expect(movingAverage([10, 20, 30, 40], 2)).toBe(15);
  });
  it('returns null when fewer than n points', () => {
    expect(movingAverage([10], 2)).toBeNull();
    expect(movingAverage([], 5)).toBeNull();
  });
  it('uses all points when n equals length', () => {
    expect(movingAverage([10, 20, 30], 3)).toBe(20);
  });
});

describe('dailyVolatility', () => {
  it('returns 0 for a flat series', () => {
    expect(dailyVolatility([100, 100, 100, 100])).toBe(0);
  });
  it('computes a positive stdev of daily returns for a moving series', () => {
    const v = dailyVolatility([110, 100, 110, 100, 110]); // alternating ±10%
    expect(v).toBeGreaterThan(0.05);
  });
  it('returns 0 when fewer than 2 points', () => {
    expect(dailyVolatility([100])).toBe(0);
  });
});

describe('recentSwingLow', () => {
  it('returns the minimum of the most recent n lows', () => {
    expect(recentSwingLow([12, 9, 15, 8, 20], 3)).toBe(9); // min of first 3 (newest)
  });
  it('returns null on empty input', () => {
    expect(recentSwingLow([], 5)).toBeNull();
  });
});
