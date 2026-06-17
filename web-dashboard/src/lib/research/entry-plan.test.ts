import { describe, it, expect } from 'vitest';
import { buildTranches } from './entry-plan';
import type { EntryInput } from './entry-types';

const base: EntryInput = {
  desiredUsd: 4000, currentPrice: 100,
  ma8: 99, ma20: 96, ma50: 92, low52w: 70, recentSwingLow: 95, dailyVol: 0.03,
};

describe('buildTranches', () => {
  it('medium volatility yields 4 tranches', () => {
    expect(buildTranches(base).length).toBe(4);
  });
  it('low volatility yields 3 tranches, high yields 6', () => {
    expect(buildTranches({ ...base, dailyVol: 0.01 }).length).toBe(3);
    expect(buildTranches({ ...base, dailyVol: 0.05 }).length).toBe(6);
  });
  it('never places a limit above the current price (no chasing)', () => {
    for (const t of buildTranches(base)) {
      expect(t.limitPrice).toBeLessThanOrEqual(base.currentPrice);
    }
  });
  it('ladders prices strictly downward', () => {
    const ts = buildTranches(base);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i].limitPrice).toBeLessThanOrEqual(ts[i - 1].limitPrice);
    }
  });
  it('total cost does not exceed the desired position', () => {
    const ts = buildTranches(base);
    const total = ts.reduce((s, t) => s + t.shares * t.limitPrice, 0);
    expect(total).toBeLessThanOrEqual(base.desiredUsd);
  });
  it('every tranche has positive shares and a notional >= 100', () => {
    for (const t of buildTranches(base)) {
      expect(t.shares).toBeGreaterThan(0);
      expect(t.shares * t.limitPrice).toBeGreaterThanOrEqual(100);
    }
  });
  it('assigns 1-based trancheN and a non-empty rationale', () => {
    const ts = buildTranches(base);
    expect(ts[0].trancheN).toBe(1);
    expect(ts[ts.length - 1].trancheN).toBe(ts.length);
    expect(ts[0].rationale.length).toBeGreaterThan(0);
  });
});
