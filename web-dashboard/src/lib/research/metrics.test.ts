import { describe, it, expect } from 'vitest';
import { cagr } from './metrics';

describe('cagr', () => {
  it('computes compound annual growth rate over the span', () => {
    // 100 -> 200 over 2 periods (3 data points) => sqrt(2)-1 ≈ 0.4142
    expect(cagr([100, 150, 200])).toBeCloseTo(0.4142, 3);
  });

  it('returns 0 for a flat series', () => {
    expect(cagr([100, 100, 100])).toBe(0);
  });

  it('returns null when the first value is <= 0 (undefined growth)', () => {
    expect(cagr([0, 50, 100])).toBeNull();
    expect(cagr([-10, 50, 100])).toBeNull();
  });

  it('returns null when fewer than 2 valid points', () => {
    expect(cagr([100])).toBeNull();
    expect(cagr([])).toBeNull();
  });

  it('ignores null entries, using first and last non-null', () => {
    expect(cagr([100, null, 200])).toBeCloseTo(0.4142, 3);
  });
});
