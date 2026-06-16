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

import { computeMetrics } from './metrics';
import type { AnnualStatement, CompanyOverview } from './types';

const latest: AnnualStatement = {
  fiscalYear: '2024',
  revenue: 1000, grossProfit: 600, ebitda: 250, operatingIncome: 200,
  netIncome: 150, eps: 3, totalDebt: 400, cash: 100, totalEquity: 800,
  accountsReceivable: 200, inventory: 125, costOfRevenue: 400, interestExpense: 50,
};
const overview: CompanyOverview = {
  marketCap: 3000, sharesOutstanding: 1000, peRatio: 20,
  sector: 'Tech', industry: 'Software', name: 'Test Co', price: 60,
};

describe('computeMetrics', () => {
  const rows = computeMetrics(latest, overview);
  const byLabel = (l: string) => rows.find((r) => r.label === l)!;

  it('computes enterprise value = marketCap + totalDebt - cash', () => {
    expect(byLabel('Enterprise Value').value).toBe(3300); // 3000+400-100
  });
  it('computes debt/equity', () => {
    expect(byLabel('Debt/Equity').value).toBeCloseTo(0.5, 4); // 400/800
  });
  it('computes interest coverage = operatingIncome / interestExpense', () => {
    expect(byLabel('Interest Coverage').value).toBeCloseTo(4, 4); // 200/50
  });
  it('computes AR turnover = revenue / accountsReceivable', () => {
    expect(byLabel('AR Turnover').value).toBeCloseTo(5, 4); // 1000/200
  });
  it('computes inventory turnover = costOfRevenue / inventory', () => {
    expect(byLabel('Inventory Turnover').value).toBeCloseTo(3.2, 4); // 400/125
  });
  it('computes EV/Revenue and EV/EBITDA', () => {
    expect(byLabel('EV/Revenue').value).toBeCloseTo(3.3, 4);   // 3300/1000
    expect(byLabel('EV/EBITDA').value).toBeCloseTo(13.2, 4);   // 3300/250
  });
  it('passes through P/E and BS cash', () => {
    expect(byLabel('P/E').value).toBe(20);
    expect(byLabel('Cash (BS)').value).toBe(100);
  });
  it('returns null value (not throw) when a denominator is null/zero', () => {
    const noEquity = { ...latest, totalEquity: 0 };
    const r = computeMetrics(noEquity, overview).find((x) => x.label === 'Debt/Equity')!;
    expect(r.value).toBeNull();
  });
});
