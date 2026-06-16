import type { AnnualStatement, CompanyOverview, MetricRow } from './types';

/**
 * Compound annual growth rate over a series of period values (oldest→newest).
 * Null entries are skipped but their positions still count as periods — the
 * period count is (original series length - 1), not (non-null count - 1).
 * Returns a fraction (0.18 = 18%), or null when undefined (first<=0, <2 points).
 */
export function cagr(series: (number | null)[]): number | null {
  if (series.length < 2) return null;
  // Find first and last non-null values; period count spans the full original series.
  let begin: number | null = null;
  let end: number | null = null;
  for (const v of series) {
    if (v !== null && !Number.isNaN(v)) {
      if (begin === null) begin = v;
      end = v;
    }
  }
  if (begin === null || end === null) return null;
  if (begin <= 0) return null;
  const periods = series.length - 1;
  return Math.pow(end / begin, 1 / periods) - 1;
}

/** Safe divide: returns null if denominator is null/0 or numerator is null. */
function div(num: number | null, den: number | null): number | null {
  if (num === null || den === null || den === 0) return null;
  return num / den;
}

function add(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a + b;
}

/**
 * Deterministic valuation/health metrics. Industry benchmarks are left null
 * here; Perplexity fills them in the metrics section builder.
 */
export function computeMetrics(s: AnnualStatement, o: CompanyOverview): MetricRow[] {
  const ev = (() => {
    const base = add(o.marketCap, s.totalDebt);
    return base === null || s.cash === null ? null : base - s.cash;
  })();

  const mk = (
    label: string,
    value: number | null,
    unit: string
  ): MetricRow => ({ label, value, industryAverage: null, industryLeader: null, unit, source: 'computed' });

  return [
    mk('Enterprise Value', ev, '$'),
    mk('Debt/Equity', div(s.totalDebt, s.totalEquity), 'x'),
    mk('Interest Coverage', div(s.operatingIncome, s.interestExpense), 'x'),
    mk('Cash (BS)', s.cash, '$'),
    mk('AR Turnover', div(s.revenue, s.accountsReceivable), 'x'),
    mk('Inventory Turnover', div(s.costOfRevenue, s.inventory), 'x'),
    mk('P/E', o.peRatio, 'x'),
    mk('EV/Revenue', div(ev, s.revenue), 'x'),
    mk('EV/EBITDA', div(ev, s.ebitda), 'x'),
  ];
}
