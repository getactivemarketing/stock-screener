# Screen 1: Company Analysis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/research/company` page to the dashboard that takes a ticker and renders a five-tab fundamental analysis (Financials, Metrics, Comps, Opportunities & Risks, Investment Grade), each section fetched independently and cached per day.

**Architecture:** New SvelteKit server route `/api/research/company/[symbol]?section=…` does the work directly (matching the existing `/api/ticker/[symbol]?type=` pattern). Hard numbers come from Alpha Vantage statement endpoints + Yahoo/AV quotes; estimates, comps benchmarks, earnings-call synthesis, and the 0–100 grade come from Perplexity (`sonar`). Each section result is cached in a new `company_analysis` table keyed by `(ticker, section, analysis_date)`.

**Tech Stack:** SvelteKit 2 + Svelte 5, TypeScript, Postgres (`pg`), `openai` SDK (Perplexity-compatible), Vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-16-research-screens-design.md` (Screen 1 only; Screen 2 gets a separate plan).

**Note on migrations:** the spec grouped all three tables into `migration-013`. This plan creates `migration-013-research.sql` with **only** `company_analysis`; Screen 2's plan will add `entry_plans`/`entry_orders` in a later migration. This keeps each plan independently shippable.

---

## File Structure

All paths under `web-dashboard/` unless noted.

- `src/lib/research/types.ts` — TypeScript types for each section payload and the statement data.
- `src/lib/research/metrics.ts` — **pure** functions: `cagr()` and `computeMetrics()` (valuation/health ratios). Fully unit-tested.
- `src/lib/research/perplexity.ts` — Perplexity client + `askPerplexityJSON()` (network) and `parseJSONResponse()` (pure, unit-tested).
- `src/lib/research/statements.ts` — Alpha Vantage `INCOME_STATEMENT`/`BALANCE_SHEET`/`CASH_FLOW`/`OVERVIEW` fetchers (network; manual verify).
- `src/lib/research/company-sections.ts` — cache get/upsert + the five section builders that combine statements + Perplexity.
- `src/routes/api/research/company/[symbol]/+server.ts` — GET route, `?section=` dispatch + cache + `?refresh=1`.
- `src/routes/research/company/+page.svelte` — UI: ticker input, five tabs, per-tab loading/error, Refresh.
- `src/routes/research/+layout.svelte` — Research section shell (heading + nav).
- `src/routes/+layout.svelte` (modify) — add a "Research" nav link.
- `database/migration-013-research.sql` (repo root, not under web-dashboard) — `company_analysis` table.

---

## Task 1: Set up Vitest and the Perplexity SDK in the dashboard

**Files:**
- Modify: `web-dashboard/package.json`
- Create: `web-dashboard/vitest.config.ts`
- Create: `web-dashboard/src/lib/research/smoke.test.ts` (temporary, deleted in this task)

- [ ] **Step 1: Install dependencies**

Run from `web-dashboard/`:
```bash
npm install openai@^6.16.0
npm install -D vitest@^3.0.0
```
Expected: both added to `package.json`, no peer-dep errors (repo uses `legacy-peer-deps=true`).

- [ ] **Step 2: Add the test script**

In `web-dashboard/package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create the Vitest config**

Create `web-dashboard/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Add a smoke test to prove the runner works**

Create `web-dashboard/src/lib/research/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('vitest', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run the smoke test**

Run from `web-dashboard/`: `npm test`
Expected: PASS, 1 test passed.

- [ ] **Step 6: Delete the smoke test and commit**

```bash
rm web-dashboard/src/lib/research/smoke.test.ts
git add web-dashboard/package.json web-dashboard/package-lock.json web-dashboard/vitest.config.ts
git commit -m "chore(dashboard): add vitest + openai SDK for research screens"
```

---

## Task 2: Create the `company_analysis` cache table

**Files:**
- Create: `database/migration-013-research.sql`

- [ ] **Step 1: Write the migration**

Create `database/migration-013-research.sql`:
```sql
-- Migration 013: Research screens — Screen 1 (Company Analysis) cache
CREATE TABLE IF NOT EXISTS company_analysis (
  id            SERIAL PRIMARY KEY,
  ticker        TEXT NOT NULL,
  section       TEXT NOT NULL CHECK (section IN ('financials','metrics','comps','oppsrisks','grade')),
  analysis_date DATE NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticker, section, analysis_date)
);

CREATE INDEX IF NOT EXISTS idx_company_analysis_lookup
  ON company_analysis (ticker, section, analysis_date);
```

- [ ] **Step 2: Apply the migration to the prod DB**

Run (public proxy URL from project notes):
```bash
psql "postgresql://postgres:WMxIRbXdhNvmSMIBIayQYyfSXeATlQCE@switchyard.proxy.rlwy.net:15765/railway" -f database/migration-013-research.sql
```
Expected: `CREATE TABLE`, `CREATE INDEX` (or no error if re-run).

- [ ] **Step 3: Verify the table exists**

Run:
```bash
psql "postgresql://postgres:WMxIRbXdhNvmSMIBIayQYyfSXeATlQCE@switchyard.proxy.rlwy.net:15765/railway" -c "\d company_analysis"
```
Expected: shows the 6 columns and the unique constraint.

- [ ] **Step 4: Commit**

```bash
git add database/migration-013-research.sql
git commit -m "feat(db): add company_analysis cache table (migration 013)"
```

---

## Task 3: Define section payload + statement types

**Files:**
- Create: `web-dashboard/src/lib/research/types.ts`

- [ ] **Step 1: Write the types**

Create `web-dashboard/src/lib/research/types.ts`:
```ts
export type Section = 'financials' | 'metrics' | 'comps' | 'oppsrisks' | 'grade';

/** One annual period of statement data (numbers in USD, raw). */
export interface AnnualStatement {
  fiscalYear: string;        // e.g. "2024"
  revenue: number | null;
  grossProfit: number | null;
  ebitda: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  eps: number | null;
  // balance sheet
  totalDebt: number | null;
  cash: number | null;
  totalEquity: number | null;
  accountsReceivable: number | null;
  inventory: number | null;
  costOfRevenue: number | null;
  interestExpense: number | null;
}

export interface CompanyOverview {
  marketCap: number | null;
  sharesOutstanding: number | null;
  peRatio: number | null;
  sector: string | null;
  industry: string | null;
  name: string | null;
  price: number | null;
}

// ---- Section payloads (the JSONB stored per section) ----

export interface FinancialsRow {
  label: string;             // "Revenue", "Gross Profit", ...
  values: (number | null)[]; // one per historical year, oldest→newest
  forwardEstimate: number | null;
  cagr: number | null;       // fraction, e.g. 0.18 = 18%
  driverCommentary: string;
}

export interface FinancialsPayload {
  years: string[];           // historical fiscal years, oldest→newest
  forwardYear: string | null;
  rows: FinancialsRow[];
  managementBelievabilityNote: string;
  estimated: boolean;        // true if forward/commentary came from Perplexity
}

export interface MetricRow {
  label: string;             // "Enterprise Value", "Debt/Equity", ...
  value: number | null;
  industryAverage: number | null;
  industryLeader: number | null;
  unit: string;              // "$", "x", "%", ""
  source: 'computed' | 'estimated';
}

export interface MetricsPayload {
  rows: MetricRow[];
}

export interface CompsPeer {
  ticker: string;
  evToRevenue: number | null;
  grossMargin: number | null;     // %
  ebitdaMargin: number | null;    // %
  netMargin: number | null;       // %
}

export interface CompsPayload {
  industry: string | null;
  subject: CompsPeer;             // the analyzed ticker
  peers: CompsPeer[];
}

export interface OppsRisksPayload {
  opportunities: string[];
  risks: string[];
}

export interface GradePayload {
  score: number;             // 0-100
  band: string;              // e.g. "61-80: Clear opportunity"
  rationale: string;
}

export type SectionPayload =
  | FinancialsPayload
  | MetricsPayload
  | CompsPayload
  | OppsRisksPayload
  | GradePayload;
```

- [ ] **Step 2: Type-check**

Run from `web-dashboard/`: `npx tsc --noEmit`
Expected: no errors from `types.ts`.

- [ ] **Step 3: Commit**

```bash
git add web-dashboard/src/lib/research/types.ts
git commit -m "feat(research): add section + statement types"
```

---

## Task 4: Implement and test `cagr()`

**Files:**
- Create: `web-dashboard/src/lib/research/metrics.ts`
- Test: `web-dashboard/src/lib/research/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web-dashboard/src/lib/research/metrics.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run from `web-dashboard/`: `npm test -- metrics`
Expected: FAIL — `cagr is not a function` / module not found.

- [ ] **Step 3: Implement `cagr`**

Create `web-dashboard/src/lib/research/metrics.ts`:
```ts
/**
 * Compound annual growth rate over a series of period values (oldest→newest).
 * Returns a fraction (0.18 = 18%), or null when undefined (first<=0, <2 points).
 */
export function cagr(series: (number | null)[]): number | null {
  const valid = series.filter((v): v is number => v !== null && !Number.isNaN(v));
  if (valid.length < 2) return null;
  const begin = valid[0];
  const end = valid[valid.length - 1];
  const periods = valid.length - 1;
  if (begin <= 0) return null;
  return Math.pow(end / begin, 1 / periods) - 1;
}
```

- [ ] **Step 4: Run to verify it passes**

Run from `web-dashboard/`: `npm test -- metrics`
Expected: PASS — all 5 `cagr` tests green.

- [ ] **Step 5: Commit**

```bash
git add web-dashboard/src/lib/research/metrics.ts web-dashboard/src/lib/research/metrics.test.ts
git commit -m "feat(research): add cagr() with tests"
```

---

## Task 5: Implement and test `computeMetrics()`

**Files:**
- Modify: `web-dashboard/src/lib/research/metrics.ts`
- Modify: `web-dashboard/src/lib/research/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web-dashboard/src/lib/research/metrics.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run from `web-dashboard/`: `npm test -- metrics`
Expected: FAIL — `computeMetrics is not a function`.

- [ ] **Step 3: Implement `computeMetrics`**

Append to `web-dashboard/src/lib/research/metrics.ts`:
```ts
import type { AnnualStatement, CompanyOverview, MetricRow } from './types';

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
```

- [ ] **Step 4: Run to verify it passes**

Run from `web-dashboard/`: `npm test -- metrics`
Expected: PASS — all `cagr` + `computeMetrics` tests green.

- [ ] **Step 5: Commit**

```bash
git add web-dashboard/src/lib/research/metrics.ts web-dashboard/src/lib/research/metrics.test.ts
git commit -m "feat(research): add computeMetrics() with tests"
```

---

## Task 6: Perplexity client + JSON parser

**Files:**
- Create: `web-dashboard/src/lib/research/perplexity.ts`
- Test: `web-dashboard/src/lib/research/perplexity.test.ts`

- [ ] **Step 1: Write the failing test (parser only — pure)**

Create `web-dashboard/src/lib/research/perplexity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseJSONResponse } from './perplexity';

describe('parseJSONResponse', () => {
  it('parses clean JSON', () => {
    expect(parseJSONResponse('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips ```json fences', () => {
    expect(parseJSONResponse('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it('strips bare ``` fences', () => {
    expect(parseJSONResponse('```\n{"a":3}\n```')).toEqual({ a: 3 });
  });
  it('extracts the first JSON object embedded in prose', () => {
    expect(parseJSONResponse('Here you go: {"a":4} cheers')).toEqual({ a: 4 });
  });
  it('returns null on unparseable input', () => {
    expect(parseJSONResponse('not json at all')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run from `web-dashboard/`: `npm test -- perplexity`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement the client + parser**

Create `web-dashboard/src/lib/research/perplexity.ts`:
```ts
import OpenAI from 'openai';

/** Strip markdown fences / prose and parse the first JSON object. Returns null on failure. */
export function parseJSONResponse(text: string): unknown | null {
  if (!text) return null;
  let t = text.trim();
  // strip ```json ... ``` or ``` ... ```
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // fall through to embedded-object extraction
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Ask Perplexity (sonar) for a JSON answer. Returns parsed object or null.
 * `apiKey` is passed in by the caller (route reads it from env) for testability.
 */
export async function askPerplexityJSON(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2000
): Promise<unknown | null> {
  const client = new OpenAI({ apiKey, baseURL: 'https://api.perplexity.ai' });
  try {
    const res = await client.chat.completions.create({
      model: 'sonar',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    });
    return parseJSONResponse(res.choices[0]?.message?.content || '');
  } catch (err) {
    console.error('[perplexity] request failed:', err);
    return null;
  }
}

export const JSON_SYSTEM_PROMPT =
  'You are a professional equity analyst. Respond ONLY with valid JSON matching the requested schema, no markdown fences, no commentary.';
```

- [ ] **Step 4: Run to verify it passes**

Run from `web-dashboard/`: `npm test -- perplexity`
Expected: PASS — all 5 parser tests green.

- [ ] **Step 5: Commit**

```bash
git add web-dashboard/src/lib/research/perplexity.ts web-dashboard/src/lib/research/perplexity.test.ts
git commit -m "feat(research): add Perplexity client + JSON parser with tests"
```

---

## Task 7: Alpha Vantage statement fetchers

**Files:**
- Create: `web-dashboard/src/lib/research/statements.ts`

This task is network-bound; verify manually rather than with unit tests.

- [ ] **Step 1: Implement the fetchers**

Create `web-dashboard/src/lib/research/statements.ts`:
```ts
import type { AnnualStatement, CompanyOverview } from './types';

const BASE = 'https://www.alphavantage.co/query';

function num(v: string | undefined): number | null {
  if (!v || v === 'None' || v === '-') return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

async function avGet(fn: string, ticker: string, apiKey: string): Promise<any> {
  const res = await fetch(`${BASE}?function=${fn}&symbol=${ticker}&apikey=${apiKey}`);
  if (!res.ok) throw new Error(`AlphaVantage ${fn} HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch up to 5 fiscal years of merged statement data, oldest→newest.
 * Returns [] if Alpha Vantage returns no annual reports (rate limit / unknown ticker).
 */
export async function fetchStatements(ticker: string, apiKey: string): Promise<AnnualStatement[]> {
  const [income, balance, cash] = await Promise.all([
    avGet('INCOME_STATEMENT', ticker, apiKey),
    avGet('BALANCE_SHEET', ticker, apiKey),
    avGet('CASH_FLOW', ticker, apiKey),
  ]);

  const incomeReports: any[] = income?.annualReports ?? [];
  if (incomeReports.length === 0) return [];

  const balByYear = new Map<string, any>();
  for (const r of balance?.annualReports ?? []) balByYear.set(r.fiscalDateEnding?.slice(0, 4), r);
  // cash flow currently unused for the listed line items but fetched for future use
  void cash;

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
```

- [ ] **Step 2: Type-check**

Run from `web-dashboard/`: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual smoke (optional but recommended)**

Create a throwaway script `web-dashboard/scratch.mjs` (NOT committed):
```js
import { fetchStatements, fetchOverview } from './src/lib/research/statements.ts';
const key = process.env.ALPHA_VANTAGE_API_KEY;
console.log(JSON.stringify(await fetchStatements('AAPL', key), null, 2));
console.log(await fetchOverview('AAPL', key));
```
Run: `ALPHA_VANTAGE_API_KEY=<key> npx tsx scratch.mjs`
Expected: 1–5 year rows with non-null revenue, an overview with marketCap. Then `rm web-dashboard/scratch.mjs`.

- [ ] **Step 4: Commit**

```bash
git add web-dashboard/src/lib/research/statements.ts
git commit -m "feat(research): add Alpha Vantage statement + overview fetchers"
```

---

## Task 8: Section builders + cache

**Files:**
- Create: `web-dashboard/src/lib/research/company-sections.ts`

- [ ] **Step 1: Implement cache helpers + the five builders**

Create `web-dashboard/src/lib/research/company-sections.ts`:
```ts
import { query } from '$lib/db';
import { fetchStatements, fetchOverview } from './statements';
import { cagr, computeMetrics } from './metrics';
import { askPerplexityJSON, JSON_SYSTEM_PROMPT } from './perplexity';
import type {
  Section, FinancialsPayload, FinancialsRow, MetricsPayload,
  CompsPayload, OppsRisksPayload, GradePayload, AnnualStatement, CompanyOverview,
} from './types';

const FINANCIAL_ROWS: { key: keyof AnnualStatement; label: string }[] = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'grossProfit', label: 'Gross Profit' },
  { key: 'ebitda', label: 'EBITDA' },
  { key: 'operatingIncome', label: 'Operating Income' },
  { key: 'netIncome', label: 'Net Income' },
];

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Read a cached section payload for today, or null. */
export async function getCached(ticker: string, section: Section): Promise<unknown | null> {
  const rows = await query<{ payload: unknown }>(
    `SELECT payload FROM company_analysis
     WHERE ticker = $1 AND section = $2 AND analysis_date = $3`,
    [ticker, section, todayUTC()]
  );
  return rows[0]?.payload ?? null;
}

/** Upsert today's section payload. */
export async function putCached(ticker: string, section: Section, payload: unknown): Promise<void> {
  await query(
    `INSERT INTO company_analysis (ticker, section, analysis_date, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ticker, section, analysis_date)
     DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
    [ticker, section, todayUTC(), JSON.stringify(payload)]
  );
}

// ---- Section builders ----

export async function buildFinancials(ticker: string, avKey: string, pplxKey: string): Promise<FinancialsPayload> {
  const statements = await fetchStatements(ticker, avKey);
  const years = statements.map((s) => s.fiscalYear);

  // Perplexity: forward estimate + per-row driver commentary + believability note
  const pplx = (await askPerplexityJSON(
    pplxKey,
    JSON_SYSTEM_PROMPT,
    `For ${ticker}, using the latest fiscal years ${years.join(', ')}, return JSON:
{"forwardYear":"<year>","forwardRevenue":<num|null>,"drivers":{"Revenue":"<one line>","Gross Profit":"...","EBITDA":"...","Operating Income":"...","Net Income":"..."},"managementBelievabilityNote":"<2-3 sentences grading how well aggressive targets are supported by historical trend and market size>"}`
  )) as any;

  const rows: FinancialsRow[] = FINANCIAL_ROWS.map(({ key, label }) => {
    const values = statements.map((s) => s[key] as number | null);
    return {
      label,
      values,
      forwardEstimate: label === 'Revenue' ? (pplx?.forwardRevenue ?? null) : null,
      cagr: cagr(values),
      driverCommentary: pplx?.drivers?.[label] ?? '',
    };
  });

  return {
    years,
    forwardYear: pplx?.forwardYear ?? null,
    rows,
    managementBelievabilityNote: pplx?.managementBelievabilityNote ?? '',
    estimated: !!pplx,
  };
}

export async function buildMetrics(ticker: string, avKey: string, pplxKey: string): Promise<MetricsPayload> {
  const [statements, overview] = await Promise.all([
    fetchStatements(ticker, avKey),
    fetchOverview(ticker, avKey),
  ]);
  const latest = statements[statements.length - 1];
  const rows = latest ? computeMetrics(latest, overview) : [];

  // Perplexity: industry average + leader benchmarks for each metric label
  const labels = rows.map((r) => r.label);
  const bench = (await askPerplexityJSON(
    pplxKey,
    JSON_SYSTEM_PROMPT,
    `For ${ticker} (${overview.industry ?? 'its industry'}), give typical industry-average and industry-leader values for these metrics: ${labels.join(', ')}.
Return JSON {"<label>":{"average":<num|null>,"leader":<num|null>}, ...}. Use the same units a financial analyst would (x for ratios, $ for EV/cash).`
  )) as any;

  for (const r of rows) {
    const b = bench?.[r.label];
    if (b) {
      r.industryAverage = typeof b.average === 'number' ? b.average : null;
      r.industryLeader = typeof b.leader === 'number' ? b.leader : null;
    }
  }
  return { rows };
}

export async function buildComps(ticker: string, avKey: string, pplxKey: string): Promise<CompsPayload> {
  const overview = await fetchOverview(ticker, avKey);
  const pplx = (await askPerplexityJSON(
    pplxKey,
    JSON_SYSTEM_PROMPT,
    `Identify 4-6 public peer companies for ${ticker} in ${overview.industry ?? 'its industry'}.
Return JSON {"industry":"<industry>","subject":{"ticker":"${ticker}","evToRevenue":<num|null>,"grossMargin":<pct|null>,"ebitdaMargin":<pct|null>,"netMargin":<pct|null>},"peers":[{"ticker":"...","evToRevenue":<num|null>,"grossMargin":<pct|null>,"ebitdaMargin":<pct|null>,"netMargin":<pct|null>}]}. Margins as percentages (e.g. 42.5).`
  )) as any;

  return {
    industry: pplx?.industry ?? overview.industry ?? null,
    subject: pplx?.subject ?? { ticker, evToRevenue: null, grossMargin: null, ebitdaMargin: null, netMargin: null },
    peers: Array.isArray(pplx?.peers) ? pplx.peers : [],
  };
}

export async function buildOppsRisks(ticker: string, pplxKey: string): Promise<OppsRisksPayload> {
  const pplx = (await askPerplexityJSON(
    pplxKey,
    JSON_SYSTEM_PROMPT,
    `Review the last 18 months of ${ticker}'s earnings reports and calls. Summarize, as JSON:
{"opportunities":["...", "..."],"risks":["...", "..."]}. 4-7 concise bullet strings each, focused on management's plans.`
  )) as any;
  return {
    opportunities: Array.isArray(pplx?.opportunities) ? pplx.opportunities : [],
    risks: Array.isArray(pplx?.risks) ? pplx.risks : [],
  };
}

export async function buildGrade(ticker: string, pplxKey: string): Promise<GradePayload> {
  const pplx = (await askPerplexityJSON(
    pplxKey,
    JSON_SYSTEM_PROMPT,
    `Assign ${ticker} an investment grade 0-100 using EXACTLY this rubric:
0-20 Highly speculative (poor/neutral fundamentals, no price momentum, risk/reward unfavorable);
21-40 Speculative (price OR fundamentals improving, not both; uncertain phase);
41-60 Neutral (sound price+fundamentals+balance sheet, no clear growth story);
61-80 Clear opportunity (growing business, price+industry momentum; younger names need realized metrics/cash flow);
81-100 Buy at any price (profits/growth outpacing price; accumulating even at ATH is risk/reward positive).
Return JSON {"score":<int 0-100>,"band":"<the matching band label>","rationale":"<3-5 sentences>"}.`
  )) as any;
  const score = typeof pplx?.score === 'number' ? Math.max(0, Math.min(100, Math.round(pplx.score))) : 0;
  return {
    score,
    band: pplx?.band ?? 'Unavailable',
    rationale: pplx?.rationale ?? 'Analysis unavailable.',
  };
}
```

- [ ] **Step 2: Type-check**

Run from `web-dashboard/`: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web-dashboard/src/lib/research/company-sections.ts
git commit -m "feat(research): add section builders + day-keyed cache"
```

---

## Task 9: The API route

**Files:**
- Create: `web-dashboard/src/routes/api/research/company/[symbol]/+server.ts`

- [ ] **Step 1: Implement the route**

Create `web-dashboard/src/routes/api/research/company/[symbol]/+server.ts`:
```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import {
  getCached, putCached,
  buildFinancials, buildMetrics, buildComps, buildOppsRisks, buildGrade,
} from '$lib/research/company-sections';
import type { Section } from '$lib/research/types';

const SECTIONS: Section[] = ['financials', 'metrics', 'comps', 'oppsrisks', 'grade'];

export const GET: RequestHandler = async ({ params, url }) => {
  const ticker = (params.symbol ?? '').toUpperCase();
  const section = url.searchParams.get('section') as Section | null;
  const refresh = url.searchParams.get('refresh') === '1';

  if (!ticker) return json({ error: 'Missing ticker' }, { status: 400 });
  if (!section || !SECTIONS.includes(section)) {
    return json({ error: `section must be one of ${SECTIONS.join(', ')}` }, { status: 400 });
  }

  const avKey = env.ALPHA_VANTAGE_API_KEY;
  const pplxKey = env.PERPLEXITY_API_KEY;
  if (!avKey || !pplxKey) {
    return json({ error: 'Data API keys not configured' }, { status: 503 });
  }

  try {
    if (!refresh) {
      const cached = await getCached(ticker, section);
      if (cached) return json({ ticker, section, cached: true, payload: cached });
    }

    let payload: unknown;
    switch (section) {
      case 'financials': payload = await buildFinancials(ticker, avKey, pplxKey); break;
      case 'metrics':    payload = await buildMetrics(ticker, avKey, pplxKey); break;
      case 'comps':      payload = await buildComps(ticker, avKey, pplxKey); break;
      case 'oppsrisks':  payload = await buildOppsRisks(ticker, pplxKey); break;
      case 'grade':      payload = await buildGrade(ticker, pplxKey); break;
    }

    await putCached(ticker, section, payload);
    return json({ ticker, section, cached: false, payload });
  } catch (err) {
    console.error(`[research/company] ${ticker}/${section} failed:`, err);
    return json({ error: `Failed to build ${section}` }, { status: 500 });
  }
};
```

- [ ] **Step 2: Type-check**

Run from `web-dashboard/`: `npx tsc --noEmit`
Expected: no errors. (`./$types` resolves once SvelteKit sees the route; if tsc complains, run `npx svelte-kit sync` first.)

- [ ] **Step 3: Manual run against the dev server**

Run from `web-dashboard/` (with `ALPHA_VANTAGE_API_KEY`, `PERPLEXITY_API_KEY`, `DATABASE_URL` in `.env`):
```bash
npm run dev
```
Then in another shell:
```bash
curl -s "http://localhost:5173/api/research/company/AAPL?section=financials" | head -c 800
```
Expected: JSON with `"cached":false` and a `payload.rows` array; a second identical call returns `"cached":true`.

- [ ] **Step 4: Commit**

```bash
git add web-dashboard/src/routes/api/research/company/\[symbol\]/+server.ts
git commit -m "feat(research): add company analysis API route with caching"
```

---

## Task 10: The Company Analysis page

**Files:**
- Create: `web-dashboard/src/routes/research/company/+page.svelte`

- [ ] **Step 1: Implement the page**

Create `web-dashboard/src/routes/research/company/+page.svelte`:
```svelte
<script lang="ts">
  type Tab = { id: string; label: string };
  const TABS: Tab[] = [
    { id: 'financials', label: 'Financials' },
    { id: 'metrics', label: 'Metrics' },
    { id: 'comps', label: 'Public Comps' },
    { id: 'oppsrisks', label: 'Opportunities & Risks' },
    { id: 'grade', label: 'Investment Grade' },
  ];

  let ticker = $state('');
  let active = $state('financials');
  let submitted = $state('');
  // per-section state: { loading, error, payload, cached }
  let sections = $state<Record<string, any>>({});

  async function load(section: string, refresh = false) {
    if (!submitted) return;
    sections[section] = { ...(sections[section] ?? {}), loading: true, error: null };
    try {
      const res = await fetch(
        `/api/research/company/${submitted}?section=${section}${refresh ? '&refresh=1' : ''}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      sections[section] = { loading: false, error: null, payload: data.payload, cached: data.cached };
    } catch (e: any) {
      sections[section] = { loading: false, error: e.message, payload: null };
    }
  }

  function analyze() {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    submitted = t;
    sections = {};
    active = 'financials';
    load('financials');
  }

  function selectTab(id: string) {
    active = id;
    if (submitted && !sections[id]) load(id);
  }

  function fmt(n: number | null, unit = '') {
    if (n === null || n === undefined) return '—';
    if (unit === '$') return Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`;
    if (unit === '%') return `${n.toFixed(1)}%`;
    if (unit === 'x') return `${n.toFixed(2)}x`;
    return n.toLocaleString();
  }
  function pct(n: number | null) { return n === null ? '—' : `${(n * 100).toFixed(1)}%`; }
</script>

<div class="page">
  <h1>Company Analysis</h1>
  <p class="note">Discretionary research grade — independent of the auto-trader's scores.</p>

  <div class="search">
    <input placeholder="Ticker (e.g. AAPL)" bind:value={ticker}
           onkeydown={(e) => e.key === 'Enter' && analyze()} />
    <button onclick={analyze}>Analyze</button>
  </div>

  {#if submitted}
    <div class="tabs">
      {#each TABS as t}
        <button class:active={active === t.id} onclick={() => selectTab(t.id)}>{t.label}</button>
      {/each}
    </div>

    {#key active}
      {@const s = sections[active]}
      <div class="panel">
        <div class="panel-head">
          <span>{submitted} — {TABS.find((t) => t.id === active)?.label}</span>
          {#if s?.cached}<span class="badge">cached today</span>{/if}
          <button class="refresh" onclick={() => load(active, true)} disabled={s?.loading}>Refresh</button>
        </div>

        {#if !s || s.loading}
          <p class="muted">Loading…</p>
        {:else if s.error}
          <p class="error">⚠ {s.error}</p>
        {:else if active === 'financials'}
          {#if s.payload.managementBelievabilityNote}
            <p class="believability">{s.payload.managementBelievabilityNote}</p>
          {/if}
          <table>
            <thead><tr><th>Line</th>{#each s.payload.years as y}<th>{y}</th>{/each}
              <th>{s.payload.forwardYear ?? 'Fwd'}</th><th>CAGR</th><th>Drivers</th></tr></thead>
            <tbody>
              {#each s.payload.rows as r}
                <tr><td>{r.label}</td>
                  {#each r.values as v}<td>{fmt(v, '$')}</td>{/each}
                  <td>{fmt(r.forwardEstimate, '$')}</td><td>{pct(r.cagr)}</td>
                  <td class="drivers">{r.driverCommentary}</td></tr>
              {/each}
            </tbody>
          </table>
        {:else if active === 'metrics'}
          <table>
            <thead><tr><th>Metric</th><th>Company</th><th>Industry Avg</th><th>Industry Leader</th></tr></thead>
            <tbody>
              {#each s.payload.rows as r}
                <tr><td>{r.label}</td><td>{fmt(r.value, r.unit)}</td>
                  <td>{fmt(r.industryAverage, r.unit)}</td><td>{fmt(r.industryLeader, r.unit)}</td></tr>
              {/each}
            </tbody>
          </table>
        {:else if active === 'comps'}
          <table>
            <thead><tr><th>Ticker</th><th>EV/Rev</th><th>Gross %</th><th>EBITDA %</th><th>Net %</th></tr></thead>
            <tbody>
              <tr class="subject"><td>{s.payload.subject.ticker}</td><td>{fmt(s.payload.subject.evToRevenue, 'x')}</td>
                <td>{fmt(s.payload.subject.grossMargin, '%')}</td><td>{fmt(s.payload.subject.ebitdaMargin, '%')}</td>
                <td>{fmt(s.payload.subject.netMargin, '%')}</td></tr>
              {#each s.payload.peers as p}
                <tr><td>{p.ticker}</td><td>{fmt(p.evToRevenue, 'x')}</td><td>{fmt(p.grossMargin, '%')}</td>
                  <td>{fmt(p.ebitdaMargin, '%')}</td><td>{fmt(p.netMargin, '%')}</td></tr>
              {/each}
            </tbody>
          </table>
        {:else if active === 'oppsrisks'}
          <div class="two-col">
            <div><h3>Opportunities</h3><ul>{#each s.payload.opportunities as o}<li>{o}</li>{/each}</ul></div>
            <div><h3>Risks</h3><ul>{#each s.payload.risks as r}<li>{r}</li>{/each}</ul></div>
          </div>
        {:else if active === 'grade'}
          <div class="grade"><div class="score">{s.payload.score}</div>
            <div><strong>{s.payload.band}</strong><p>{s.payload.rationale}</p></div></div>
        {/if}
      </div>
    {/key}
  {/if}
</div>

<style>
  .page { max-width: 1000px; margin: 0 auto; padding: 1.5rem; color: #e5e7eb; }
  h1 { margin-bottom: 0.25rem; }
  .note { color: #9ca3af; font-size: 0.85rem; margin-bottom: 1rem; }
  .search { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .search input { flex: 1; padding: 0.5rem; background: #111827; border: 1px solid #374151; color: #e5e7eb; border-radius: 6px; }
  .search button, .refresh { padding: 0.5rem 1rem; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; }
  .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid #374151; margin-bottom: 1rem; flex-wrap: wrap; }
  .tabs button { padding: 0.5rem 0.9rem; background: none; border: none; color: #9ca3af; cursor: pointer; border-bottom: 2px solid transparent; }
  .tabs button.active { color: #e5e7eb; border-bottom-color: #2563eb; }
  .panel-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
  .badge { font-size: 0.7rem; background: #374151; padding: 0.15rem 0.5rem; border-radius: 999px; }
  .refresh { margin-left: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 0.4rem 0.5rem; border-bottom: 1px solid #1f2937; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  td.drivers { text-align: left; color: #9ca3af; font-size: 0.78rem; max-width: 260px; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  .two-col h3 { color: #e5e7eb; } .two-col li { margin-bottom: 0.4rem; color: #d1d5db; }
  .grade { display: flex; gap: 1.5rem; align-items: center; }
  .grade .score { font-size: 3rem; font-weight: 700; color: #22c55e; }
  .subject { background: #0b2545; font-weight: 600; }
  .muted { color: #9ca3af; } .error { color: #f87171; }
  .believability { color: #d1d5db; font-style: italic; margin-bottom: 0.75rem; }
</style>
```

- [ ] **Step 2: Type-check + build**

Run from `web-dashboard/`: `npx svelte-kit sync && npm run build`
Expected: build succeeds, no Svelte/TS errors.

- [ ] **Step 3: Manual visual check**

`npm run dev`, open `http://localhost:5173/research/company`, enter `AAPL`, click Analyze. Each tab loads on click; Financials shows years + CAGR; Refresh re-runs and clears the "cached today" badge briefly.

- [ ] **Step 4: Commit**

```bash
git add web-dashboard/src/routes/research/company/+page.svelte
git commit -m "feat(research): add Company Analysis page (five tabs)"
```

---

## Task 11: Research nav link + section shell

**Files:**
- Create: `web-dashboard/src/routes/research/+layout.svelte`
- Modify: `web-dashboard/src/routes/+layout.svelte`

- [ ] **Step 1: Create the research layout shell**

Create `web-dashboard/src/routes/research/+layout.svelte`:
```svelte
<script lang="ts">
  let { children } = $props();
</script>

<nav class="research-nav">
  <a href="/research/company">Company Analysis</a>
</nav>
{@render children()}

<style>
  .research-nav { display: flex; gap: 1rem; padding: 0.75rem 1.5rem; border-bottom: 1px solid #1f2937; }
  .research-nav a { color: #9ca3af; text-decoration: none; }
  .research-nav a:hover { color: #e5e7eb; }
</style>
```

- [ ] **Step 2: Add the top-level nav link**

In `web-dashboard/src/routes/+layout.svelte`, find the existing nav link list (the same block containing the Performance/Portfolio/Analytics links) and add a Research link alongside them:
```svelte
<a href="/research/company">Research</a>
```
Match the existing markup/classes used by the neighboring links exactly (read the file first to copy the pattern).

- [ ] **Step 3: Build**

Run from `web-dashboard/`: `npm run build`
Expected: success; the Research link appears in the top nav and routes to the page.

- [ ] **Step 4: Commit**

```bash
git add web-dashboard/src/routes/research/+layout.svelte web-dashboard/src/routes/+layout.svelte
git commit -m "feat(research): add Research nav link + section shell"
```

---

## Task 12: Full-suite check, env, deploy verification

**Files:** none (verification + deploy)

- [ ] **Step 1: Run the whole unit suite**

Run from `web-dashboard/`: `npm test`
Expected: all `metrics` + `perplexity` tests pass, 0 failures.

- [ ] **Step 2: Confirm Vercel env vars**

Ensure `ALPHA_VANTAGE_API_KEY` and `PERPLEXITY_API_KEY` exist in the Vercel project env for `web-dashboard` (the route returns 503 without them). Add via the Vercel dashboard or `vercel env add` if missing. `DATABASE_URL` is already set.

- [ ] **Step 3: Deploy (Vercel does NOT auto-deploy this project)**

Run from `web-dashboard/`:
```bash
vercel --prod
```
Expected: build succeeds, aliased to the production URL.

- [ ] **Step 4: Production smoke test**

Open `https://<prod-url>/research/company`, analyze a well-covered ticker (e.g. `MSFT`) and a thinner one. Verify: all five tabs render; AV-thin tickers degrade gracefully (metrics show `—`, financials still show Perplexity-sourced forward/commentary); Refresh works; second load is cached.

- [ ] **Step 5: Final commit (if any tweaks were needed)**

```bash
git add -A
git commit -m "chore(research): Screen 1 deploy verification"
```

---

## Self-Review

**Spec coverage (Screen 1 sections of the spec):**
- §3 Tab 1 Financials (5yr + forward + CAGR + drivers + believability note) → Tasks 5/7/8/10 ✓
- §3 Tab 2 Metrics (EV, D/E, interest coverage, cash, AR/inv turnover, P/E, EV/Rev, EV/EBITDA + benchmarks) → Tasks 5/8 ✓
- §3 Tab 3 Public Comps (peer table, margins) → Task 8 (`buildComps`) ✓
- §3 Tab 4 Opportunities & Risks (18-mo earnings synthesis) → Task 8 (`buildOppsRisks`) ✓
- §3 Tab 5 Investment Grade (0–100 rubric) → Task 8 (`buildGrade`) ✓
- §3 Separation from auto-trader (labeled) → Task 10 (`.note`) ✓
- §2 Section-by-section fetch + Vercel-duration mitigation → Task 9 ✓
- §2 Day-keyed caching + Refresh → Tasks 8/9/10 ✓
- §5 `company_analysis` table → Task 2 ✓
- §6 Per-section error states, AV-degradation flag, cost via caching → Tasks 8/9/10 ✓
- §6 Testing (CAGR, metric math; mocked parse) → Tasks 4/5/6 ✓

**Placeholder scan:** every code step has complete code; no TBD/TODO; commands have expected output. ✓

**Type consistency:** `Section`, `AnnualStatement`, `CompanyOverview`, `MetricRow`, and the payload types defined in Task 3 are used consistently by `metrics.ts` (4/5), `statements.ts` (7), `company-sections.ts` (8), and the route (9). `cagr`/`computeMetrics`/`parseJSONResponse`/`askPerplexityJSON`/`getCached`/`putCached`/the five `build*` names match across tasks. ✓

**Deferred to Screen 2 plan (intentionally out of this plan):** `entry_plans`/`entry_orders` tables, `/research/entry` page + routes, Alpaca order staging, GTC/`client_order_id` order changes.
