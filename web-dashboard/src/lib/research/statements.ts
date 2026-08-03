import { query } from '$lib/db';
import { isThrottleEnvelope } from './av-throttle';
import type { AnnualStatement, CompanyOverview } from './types';

const BASE = 'https://www.alphavantage.co/query';

function num(v: string | undefined): number | null {
  if (!v || v === 'None' || v === '-') return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * Fetch an Alpha Vantage function, reusing today's cached response if present.
 *
 * The five Company Analysis sections need overlapping upstream data — a full
 * analysis asks for INCOME_STATEMENT and BALANCE_SHEET twice and OVERVIEW twice
 * — which burns roughly double the requests against a ~25/day free-tier cap.
 * Caching per (ticker, function, day) collapses those to one call each.
 *
 * Throttle envelopes are never cached, so a quota-exhausted response does not
 * poison the rest of the day.
 */
async function avGet(fn: string, ticker: string, apiKey: string): Promise<any> {
  const today = new Date().toISOString().slice(0, 10);

  try {
    const hit = await query<{ payload: any }>(
      `SELECT payload FROM av_cache WHERE ticker = $1 AND fn = $2 AND fetch_date = $3`,
      [ticker, fn, today]
    );
    if (hit[0]) return hit[0].payload;
  } catch (err) {
    // A cache miss must never block a live fetch (e.g. migration not yet applied).
    console.warn(`[av_cache] read failed for ${ticker}/${fn}:`, err);
  }

  const res = await fetch(`${BASE}?function=${fn}&symbol=${ticker}&apikey=${apiKey}`);
  if (!res.ok) throw new Error(`AlphaVantage ${fn} HTTP ${res.status}`);
  const payload = await res.json();

  if (!isThrottleEnvelope(payload)) {
    try {
      await query(
        `INSERT INTO av_cache (ticker, fn, fetch_date, payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (ticker, fn, fetch_date)
         DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
        [ticker, fn, today, payload]
      );
    } catch (err) {
      console.warn(`[av_cache] write failed for ${ticker}/${fn}:`, err);
    }
  } else {
    console.warn(`[av_cache] ${ticker}/${fn} returned a throttle notice; not cached`);
  }

  return payload;
}

/**
 * Fetch up to 5 fiscal years of merged statement data, oldest→newest.
 * Returns [] if Alpha Vantage returns no annual reports (rate limit / unknown ticker).
 */
export async function fetchStatements(ticker: string, apiKey: string): Promise<AnnualStatement[]> {
  const [income, balance] = await Promise.all([
    avGet('INCOME_STATEMENT', ticker, apiKey),
    avGet('BALANCE_SHEET', ticker, apiKey),
  ]);

  const incomeReports: any[] = income?.annualReports ?? [];
  if (incomeReports.length === 0) return [];

  const balByYear = new Map<string, any>();
  for (const r of balance?.annualReports ?? []) balByYear.set(r.fiscalDateEnding?.slice(0, 4), r);

  const rows: AnnualStatement[] = incomeReports.slice(0, 5).map((r) => {
    const fy = r.fiscalDateEnding?.slice(0, 4) ?? '';
    const b = balByYear.get(fy) ?? {};
    const revenue = num(r.totalRevenue);
    const operatingIncome = num(r.operatingIncome);
    const depreciation = num(r.depreciationAndAmortization);
    return {
      fiscalYear: fy,
      revenue,
      grossProfit: num(r.grossProfit),
      ebitda: operatingIncome !== null && depreciation !== null ? operatingIncome + depreciation : num(r.ebitda),
      operatingIncome,
      netIncome: num(r.netIncome),
      eps: null, // EPS comes from OVERVIEW/derived; left null at statement level
      totalDebt: (() => {
        const sd = num(b.shortLongTermDebtTotal);
        if (sd !== null) return sd;
        const s = num(b.currentDebt);
        const l = num(b.longTermDebt);
        if (s === null && l === null) return null;
        return (s ?? 0) + (l ?? 0);
      })(),
      cash: num(b.cashAndCashEquivalentsAtCarryingValue),
      totalEquity: num(b.totalShareholderEquity),
      accountsReceivable: num(b.currentNetReceivables),
      inventory: num(b.inventory),
      costOfRevenue: num(r.costOfRevenue),
      interestExpense: num(r.interestExpense),
    };
  });

  // oldest→newest
  return rows.reverse();
}

export async function fetchOverview(ticker: string, apiKey: string): Promise<CompanyOverview> {
  const d = await avGet('OVERVIEW', ticker, apiKey);
  return {
    marketCap: num(d?.MarketCapitalization),
    sharesOutstanding: num(d?.SharesOutstanding),
    peRatio: num(d?.PERatio),
    sector: d?.Sector ?? null,
    industry: d?.Industry ?? null,
    name: d?.Name ?? null,
    price: null, // filled from quote elsewhere if needed
  };
}
