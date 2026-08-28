# Screen 2: Entry Analysis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/research/entry` page where the user enters a ticker + desired $ position and gets a staged limit-order entry plan (≤6 tranches), then can stage those orders as tagged GTC limit buys on the bot's Alpaca paper account, with live status reconciliation and "cancel remaining".

**Architecture:** New SvelteKit server routes do the work directly (same pattern as Screen 1 and the existing `/api/alpaca` route). Price/MA/volatility/support numbers are computed deterministically from Alpha Vantage daily series; short interest, holder composition, and volume-trend narrative come from Perplexity (`sonar`). The tranche plan (shares, limit prices, triggers) is computed by a **pure, unit-tested** function — never the LLM. Execution places GTC limit buys natively on Alpaca paper, tagged `client_order_id = s2-<ticker>-<n>`, persisted to `entry_plans`/`entry_orders`.

**Tech Stack:** SvelteKit 2 + Svelte 5, TypeScript, Postgres (`pg`), Alpha Vantage, Perplexity (`openai` SDK), Alpaca paper REST, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-16-research-screens-design.md` (Screen 2: §4, §5, §8). Builds on Screen 1's `src/lib/research/` modules (reuses `perplexity.ts`, the AV `num`/fetch pattern, and `$lib/db`).

**Branch:** continues on `research/screen1-company-analysis` (Screen 1 + Screen 2 ship together in PR #1 / one deploy).

---

## Deterministic tranche algorithm (the crux — review this first)

Pure function `buildTranches(input): Tranche[]` where `input = { desiredUsd, currentPrice, ma8, ma20, ma50, low52w, recentSwingLow, dailyVol }`.

`dailyVol` = sample standard deviation of the last 20 daily returns (a fraction, e.g. 0.03 = 3%).

1. **Volatility band & tranche count N:**
   - `dailyVol < 0.02` → **low**, `N = 3`
   - `0.02 ≤ dailyVol < 0.04` → **medium**, `N = 4`
   - `dailyVol ≥ 0.04` → **high**, `N = 6`
2. **Price ladder (all ≤ current price — never chase):**
   - `stepFrac = clamp(dailyVol, 0.01, 0.06)` (per-tranche downward spacing).
   - `firstDiscount = 0.5 * dailyVol` (more volatile → wait for a deeper first dip).
   - `anchor = min(currentPrice * (1 - firstDiscount), ma8 ?? currentPrice, recentSwingLow ?? currentPrice)` — first limit, guaranteed ≤ current price.
   - `floor = max(low52w ?? 0, currentPrice * (1 - (N) * stepFrac))` — don't ladder below this.
   - For `i` in `0..N-1`: `priceRaw_i = anchor * (1 - stepFrac * i)`; `price_i = max(priceRaw_i, floor)`, rounded to cents.
3. **Weights (more volatile → buy more on deeper dips):**
   - low → equal weights; medium → linearly increasing `(1 + 0.5*i)`; high → steeper `(1 + i)`. Normalize so `Σ w_i = 1`.
4. **Shares & $:** `targetUsd_i = desiredUsd * w_i`; `shares_i = floor(targetUsd_i / price_i)`.
   - Drop any tranche whose notional `shares_i * price_i < 100` (Alpaca $1 min, but enforce a sane $100 floor); redistribute its weight to the remaining tranches and recompute once.
   - Guarantee `Σ (shares_i * price_i) ≤ desiredUsd` (if rounding pushes over, decrement the largest tranche's shares until under).
5. **Trigger:** each tranche is a price-level limit (`"buy when ≤ $price_i"`). No time-only triggers (everything rests natively). **Rationale text is templated deterministically**, e.g. `"Tranche 2 of 4: 12 sh @ $48.20 (~4% below current, near 20-day MA). Volatility band: medium."` — not LLM-generated.

Constants (`VOL_LOW=0.02`, `VOL_HIGH=0.04`, `STEP_MIN=0.01`, `STEP_MAX=0.06`, `MIN_NOTIONAL=100`) live at the top of `entry-plan.ts` for easy tuning.

---

## File Structure

All under `web-dashboard/` unless noted.

- `database/migration-014-entry-analysis.sql` (repo root) — `entry_plans` + `entry_orders` tables.
- `src/lib/research/entry-types.ts` — types: `EntryInput`, `Indicators`, `Tranche`, `EntryAnalysis`, `EntryPlanPayload`, `EntryOrderRow`, `PlanStatus`.
- `src/lib/research/price-series.ts` — AV daily-series fetch + pure indicator math (`movingAverage`, `dailyVolatility`, `recentSwingLow`). Pure parts unit-tested.
- `src/lib/research/entry-plan.ts` — pure `buildTranches(input)` (the algorithm above). Unit-tested.
- `src/lib/research/entry-analysis.ts` — orchestrator + DB persistence (`buildEntryAnalysis`, `savePlan`, `getPlan`, `recordStagedOrders`, `reconcilePlan`, `cancelRemaining`) and the Perplexity narrative call.
- `src/lib/research/alpaca-orders.ts` — thin Alpaca paper helpers used by the routes (`placeGtcLimitBuy`, `getOrderByClientId`, `cancelOrder`), reading `ALPACA_API_KEY`/`ALPACA_API_SECRET`.
- `src/routes/api/research/entry/+server.ts` — `POST { ticker, desiredUsd }` → build + persist draft plan, return it.
- `src/routes/api/research/entry/execute/+server.ts` — `POST { planId }` → validate, place tagged GTC limit buys, persist `entry_orders`, set plan `staged`.
- `src/routes/api/research/entry/status/+server.ts` — `GET ?planId=` reconcile live Alpaca status; `POST { planId }` cancel-remaining.
- `src/routes/research/entry/+page.svelte` — the UI.
- `src/routes/research/+layout.svelte` (modify) — add "Entry Analysis" sub-nav link.

---

## Task 1: Create entry_plans + entry_orders tables (migration 014)

**Files:**
- Create: `database/migration-014-entry-analysis.sql`

- [ ] **Step 1: Write the migration**

Create `database/migration-014-entry-analysis.sql`:
```sql
-- Migration 014: Research screens — Screen 2 (Entry Analysis)
CREATE TABLE IF NOT EXISTS entry_plans (
  id                   SERIAL PRIMARY KEY,
  ticker               TEXT NOT NULL,
  desired_position_usd NUMERIC NOT NULL,
  plan                 JSONB NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','staged','cancelled')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entry_orders (
  id              SERIAL PRIMARY KEY,
  entry_plan_id   INTEGER NOT NULL REFERENCES entry_plans(id) ON DELETE CASCADE,
  tranche_n       INTEGER NOT NULL,
  client_order_id TEXT NOT NULL UNIQUE,
  alpaca_order_id TEXT,
  shares          NUMERIC NOT NULL,
  limit_price     NUMERIC NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entry_orders_plan ON entry_orders (entry_plan_id);
```

- [ ] **Step 2: Apply to prod DB**

Run:
```bash
psql "$DATABASE_URL" -f database/migration-014-entry-analysis.sql
```
Expected: `CREATE TABLE` ×2, `CREATE INDEX` (or no error on re-run). If `psql` is unavailable, apply via a throwaway Node script using the `pg` package (web-dashboard has it + a `.env` DATABASE_URL); delete the script after.

- [ ] **Step 3: Verify**

Run:
```bash
psql "$DATABASE_URL" -c "\d entry_plans" -c "\d entry_orders"
```
Expected: both tables with the columns above; `entry_orders.client_order_id` UNIQUE; FK to entry_plans.

- [ ] **Step 4: Commit**

```bash
git add database/migration-014-entry-analysis.sql
git commit -m "feat(db): add entry_plans + entry_orders tables (migration 014)"
```

---

## Task 2: Entry types

**Files:**
- Create: `web-dashboard/src/lib/research/entry-types.ts`

- [ ] **Step 1: Write the types**

Create `web-dashboard/src/lib/research/entry-types.ts`:
```ts
export type PlanStatus = 'draft' | 'staged' | 'cancelled';

/** Inputs to the pure tranche algorithm. */
export interface EntryInput {
  desiredUsd: number;
  currentPrice: number;
  ma8: number | null;
  ma20: number | null;
  ma50: number | null;
  low52w: number | null;
  recentSwingLow: number | null;
  dailyVol: number; // fraction, e.g. 0.03
}

export interface Tranche {
  trancheN: number;       // 1-based
  shares: number;
  limitPrice: number;
  rationale: string;
}

/** Computed indicators shown to the user (and fed into the plan). */
export interface Indicators {
  currentPrice: number;
  ma8: number | null;
  ma20: number | null;
  ma50: number | null;
  ma52w: number | null;     // 52-week (~252d) average
  high52w: number | null;
  low52w: number | null;
  recentSwingLow: number | null;
  dailyVol: number;
  avgVolume30d: number | null;
  latestVolume: number | null;
  relativeVolume: number | null;
  volatilityBand: 'low' | 'medium' | 'high';
}

/** Perplexity-sourced qualitative analysis. */
export interface EntryNarrative {
  volumeTrend: string;
  shortInterest: string;
  holdersAndDrivers: string;
}

/** The full persisted plan payload (entry_plans.plan JSONB). */
export interface EntryPlanPayload {
  ticker: string;
  desiredUsd: number;
  indicators: Indicators;
  narrative: EntryNarrative;
  tranches: Tranche[];
  totalShares: number;
  totalCost: number;
}

export interface EntryOrderRow {
  trancheN: number;
  clientOrderId: string;
  alpacaOrderId: string | null;
  shares: number;
  limitPrice: number;
  status: string;
}
```

- [ ] **Step 2: Type-check**

Run from `web-dashboard/`: `npx tsc --noEmit`. Expected: no errors from `entry-types.ts` (pre-existing unrelated repo errors are OK).

- [ ] **Step 3: Commit**

```bash
git add web-dashboard/src/lib/research/entry-types.ts
git commit -m "feat(research): add entry analysis types"
```

---

## Task 3: Price-series indicator math (pure, TDD)

**Files:**
- Create: `web-dashboard/src/lib/research/price-series.ts`
- Test: `web-dashboard/src/lib/research/price-series.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web-dashboard/src/lib/research/price-series.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run from `web-dashboard/`: `npm test -- price-series`. Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `web-dashboard/src/lib/research/price-series.ts`:
```ts
import type { Indicators } from './entry-types';

/** All series here are CLOSES newest-first (index 0 = most recent), matching AV ordering. */

/** Mean of the most recent `n` values. Null if fewer than `n`. */
export function movingAverage(closes: number[], n: number): number | null {
  if (closes.length < n || n <= 0) return null;
  const slice = closes.slice(0, n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

/** Sample stdev of daily simple returns across the whole series. 0 if <2 points. */
export function dailyVolatility(closes: number[]): number {
  if (closes.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 0; i < closes.length - 1; i++) {
    const newer = closes[i];
    const older = closes[i + 1];
    if (older > 0) returns.push((newer - older) / older);
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

/** Minimum of the most recent `n` lows. Null if empty. */
export function recentSwingLow(lows: number[], n: number): number | null {
  if (lows.length === 0) return null;
  return Math.min(...lows.slice(0, Math.min(n, lows.length)));
}

interface DailyBar { close: number; low: number; high: number; volume: number }

/**
 * Fetch up to ~1 year of daily bars from Alpha Vantage (newest-first) and compute indicators.
 * Returns null if AV returns no series (rate-limited / unknown ticker).
 */
export async function fetchIndicators(ticker: string, apiKey: string): Promise<Indicators | null> {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=full&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`AlphaVantage TIME_SERIES_DAILY HTTP ${res.status}`);
  const data: any = await res.json();
  const series = data?.['Time Series (Daily)'];
  if (!series) return null;

  // Object keys are dates; build newest-first arrays.
  const bars: DailyBar[] = Object.entries(series)
    .sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime())
    .map(([, v]: [string, any]) => ({
      close: parseFloat(v['4. close']),
      low: parseFloat(v['3. low']),
      high: parseFloat(v['2. high']),
      volume: parseInt(v['5. volume'], 10),
    }));

  const closes = bars.map((b) => b.close);
  const lows = bars.map((b) => b.low);
  const highs = bars.map((b) => b.high);
  const vols = bars.map((b) => b.volume);

  const window252 = closes.slice(0, 252);
  const vol30 = vols.slice(0, 30);
  const avgVolume30d = vol30.length ? Math.round(vol30.reduce((a, b) => a + b, 0) / vol30.length) : null;
  const latestVolume = vols[0] ?? null;
  const dailyVol = dailyVolatility(closes.slice(0, 21)); // ~last month
  const band: Indicators['volatilityBand'] = dailyVol < 0.02 ? 'low' : dailyVol < 0.04 ? 'medium' : 'high';

  return {
    currentPrice: closes[0],
    ma8: movingAverage(closes, 8),
    ma20: movingAverage(closes, 20),
    ma50: movingAverage(closes, 50),
    ma52w: window252.length ? window252.reduce((a, b) => a + b, 0) / window252.length : null,
    high52w: highs.length ? Math.max(...highs.slice(0, 252)) : null,
    low52w: lows.length ? Math.min(...lows.slice(0, 252)) : null,
    recentSwingLow: recentSwingLow(lows, 20),
    dailyVol,
    avgVolume30d,
    latestVolume,
    relativeVolume: avgVolume30d && latestVolume ? latestVolume / avgVolume30d : null,
    volatilityBand: band,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run from `web-dashboard/`: `npm test -- price-series`. Expected: PASS — all math tests green.

- [ ] **Step 5: Commit**

```bash
git add web-dashboard/src/lib/research/price-series.ts web-dashboard/src/lib/research/price-series.test.ts
git commit -m "feat(research): add price-series indicators (pure math tested)"
```

---

## Task 4: Tranche algorithm (pure, TDD)

**Files:**
- Create: `web-dashboard/src/lib/research/entry-plan.ts`
- Test: `web-dashboard/src/lib/research/entry-plan.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web-dashboard/src/lib/research/entry-plan.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run from `web-dashboard/`: `npm test -- entry-plan`. Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `web-dashboard/src/lib/research/entry-plan.ts`:
```ts
import type { EntryInput, Tranche } from './entry-types';

const VOL_LOW = 0.02;
const VOL_HIGH = 0.04;
const STEP_MIN = 0.01;
const STEP_MAX = 0.06;
const MIN_NOTIONAL = 100;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Deterministic staged-entry plan. See the plan doc "tranche algorithm" section.
 * Pure: no I/O, no LLM. Prices never exceed currentPrice; total cost <= desiredUsd.
 */
export function buildTranches(input: EntryInput): Tranche[] {
  const { desiredUsd, currentPrice, ma8, low52w, recentSwingLow, dailyVol } = input;

  const band: 'low' | 'medium' | 'high' = dailyVol < VOL_LOW ? 'low' : dailyVol < VOL_HIGH ? 'medium' : 'high';
  const N = band === 'low' ? 3 : band === 'medium' ? 4 : 6;

  const stepFrac = clamp(dailyVol, STEP_MIN, STEP_MAX);
  const firstDiscount = 0.5 * dailyVol;
  const anchor = Math.min(
    currentPrice * (1 - firstDiscount),
    ma8 ?? currentPrice,
    recentSwingLow ?? currentPrice
  );
  const floor = Math.max(low52w ?? 0, currentPrice * (1 - N * stepFrac));

  const prices: number[] = [];
  for (let i = 0; i < N; i++) {
    prices.push(round2(Math.max(anchor * (1 - stepFrac * i), floor)));
  }

  // Weights
  const rawWeights: number[] = [];
  for (let i = 0; i < N; i++) {
    rawWeights.push(band === 'low' ? 1 : band === 'medium' ? 1 + 0.5 * i : 1 + i);
  }
  let weightSum = rawWeights.reduce((a, b) => a + b, 0);
  let weights = rawWeights.map((w) => w / weightSum);

  // Shares; drop sub-MIN_NOTIONAL tranches and redistribute once.
  function sizeTranches(ws: number[]): { shares: number; price: number }[] {
    return ws.map((w, i) => {
      const targetUsd = desiredUsd * w;
      const shares = Math.floor(targetUsd / prices[i]);
      return { shares, price: prices[i] };
    });
  }

  let sized = sizeTranches(weights);
  const keep = sized.map((t) => t.shares * t.price >= MIN_NOTIONAL);
  if (keep.some((k) => !k) && keep.some((k) => k)) {
    const keptIdx = keep.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
    const keptWeightSum = keptIdx.reduce((s, i) => s + rawWeights[i], 0);
    weights = rawWeights.map((w, i) => (keep[i] ? w / keptWeightSum : 0));
    sized = sizeTranches(weights);
  }

  // Build tranches (only positive-share, notional>=MIN_NOTIONAL ones), then enforce total <= desiredUsd.
  let tranches: Tranche[] = [];
  let n = 1;
  for (let i = 0; i < N; i++) {
    const { shares, price } = sized[i];
    if (shares <= 0 || shares * price < MIN_NOTIONAL) continue;
    const pctBelow = round2(((currentPrice - price) / currentPrice) * 100);
    tranches.push({
      trancheN: n,
      shares,
      limitPrice: price,
      rationale: `Tranche ${n}: ${shares} sh @ $${price.toFixed(2)} (~${pctBelow}% below current). Volatility band: ${band}.`,
    });
    n++;
  }

  // Enforce total cost <= desiredUsd by trimming the largest-notional tranche.
  const totalCost = () => tranches.reduce((s, t) => s + t.shares * t.limitPrice, 0);
  while (totalCost() > desiredUsd && tranches.length > 0) {
    let bigIdx = 0;
    for (let i = 1; i < tranches.length; i++) {
      if (tranches[i].shares * tranches[i].limitPrice > tranches[bigIdx].shares * tranches[bigIdx].limitPrice) bigIdx = i;
    }
    tranches[bigIdx].shares -= 1;
    if (tranches[bigIdx].shares <= 0) tranches.splice(bigIdx, 1);
  }

  // Renumber sequentially after any drops.
  tranches = tranches.map((t, i) => ({ ...t, trancheN: i + 1 }));
  return tranches;
}
```

- [ ] **Step 4: Run to verify it passes**

Run from `web-dashboard/`: `npm test -- entry-plan`. Expected: PASS — all tranche tests green.

- [ ] **Step 5: Commit**

```bash
git add web-dashboard/src/lib/research/entry-plan.ts web-dashboard/src/lib/research/entry-plan.test.ts
git commit -m "feat(research): add deterministic tranche algorithm with tests"
```

---

## Task 5: Alpaca order helpers

**Files:**
- Create: `web-dashboard/src/lib/research/alpaca-orders.ts`

Network-bound; verify by type-check + build (exercised live in Task 11).

- [ ] **Step 1: Implement**

Create `web-dashboard/src/lib/research/alpaca-orders.ts`:
```ts
const PAPER = 'https://paper-api.alpaca.markets';

function headers(key: string, secret: string): Record<string, string> {
  return { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' };
}

export interface AlpacaOrderResult {
  id: string | null;
  clientOrderId: string;
  status: string;
  raw?: unknown;
}

/** Place a GTC limit BUY tagged with clientOrderId. Idempotent on clientOrderId (Alpaca rejects dupes). */
export async function placeGtcLimitBuy(
  key: string, secret: string,
  ticker: string, shares: number, limitPrice: number, clientOrderId: string
): Promise<AlpacaOrderResult> {
  const res = await fetch(`${PAPER}/v2/orders`, {
    method: 'POST',
    headers: headers(key, secret),
    body: JSON.stringify({
      symbol: ticker,
      qty: String(shares),
      side: 'buy',
      type: 'limit',
      time_in_force: 'gtc',
      limit_price: String(limitPrice),
      client_order_id: clientOrderId,
    }),
  });
  const raw: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { id: null, clientOrderId, status: `error: ${raw?.message ?? res.status}`, raw };
  }
  return { id: raw?.id ?? null, clientOrderId, status: raw?.status ?? 'accepted', raw };
}

export async function getOrderById(key: string, secret: string, orderId: string): Promise<any | null> {
  const res = await fetch(`${PAPER}/v2/orders/${orderId}`, { headers: headers(key, secret) });
  if (!res.ok) return null;
  return res.json();
}

export async function cancelOrder(key: string, secret: string, orderId: string): Promise<boolean> {
  const res = await fetch(`${PAPER}/v2/orders/${orderId}`, { method: 'DELETE', headers: headers(key, secret) });
  return res.ok || res.status === 404; // 404 = already gone
}
```

- [ ] **Step 2: Type-check**

Run from `web-dashboard/`: `npx tsc --noEmit`. Expected: no errors from `alpaca-orders.ts`.

- [ ] **Step 3: Commit**

```bash
git add web-dashboard/src/lib/research/alpaca-orders.ts
git commit -m "feat(research): add tagged GTC Alpaca order helpers"
```

---

## Task 6: Entry analysis orchestrator + persistence

**Files:**
- Create: `web-dashboard/src/lib/research/entry-analysis.ts`

- [ ] **Step 1: Implement**

Create `web-dashboard/src/lib/research/entry-analysis.ts`:
```ts
import { query } from '$lib/db';
import { fetchIndicators } from './price-series';
import { buildTranches } from './entry-plan';
import { askPerplexityJSON, JSON_SYSTEM_PROMPT } from './perplexity';
import { placeGtcLimitBuy, getOrderById, cancelOrder } from './alpaca-orders';
import type { EntryPlanPayload, EntryNarrative, PlanStatus, EntryOrderRow } from './entry-types';

/** Build a full draft plan (indicators + narrative + tranches). Throws if AV has no series. */
export async function buildEntryAnalysis(ticker: string, desiredUsd: number, avKey: string, pplxKey: string): Promise<EntryPlanPayload> {
  const indicators = await fetchIndicators(ticker, avKey);
  if (!indicators) throw new Error(`No price series for ${ticker}`);

  const narr = (await askPerplexityJSON(
    pplxKey,
    JSON_SYSTEM_PROMPT,
    `For ${ticker}, return JSON {"volumeTrend":"<2-3 sentences on recent volume vs historical, flag fading-on-declining-volume>","shortInterest":"<2-3 sentences: % of float short and the trend>","holdersAndDrivers":"<2-3 sentences: biggest holders (institutional/insider/retail) and drivers of recent moves: buybacks, insider buying, institutional flows>"}`
  )) as any;
  const narrative: EntryNarrative = {
    volumeTrend: narr?.volumeTrend ?? 'Unavailable.',
    shortInterest: narr?.shortInterest ?? 'Unavailable.',
    holdersAndDrivers: narr?.holdersAndDrivers ?? 'Unavailable.',
  };

  const tranches = buildTranches({
    desiredUsd,
    currentPrice: indicators.currentPrice,
    ma8: indicators.ma8,
    ma20: indicators.ma20,
    ma50: indicators.ma50,
    low52w: indicators.low52w,
    recentSwingLow: indicators.recentSwingLow,
    dailyVol: indicators.dailyVol,
  });
  const totalShares = tranches.reduce((s, t) => s + t.shares, 0);
  const totalCost = tranches.reduce((s, t) => s + t.shares * t.limitPrice, 0);

  return { ticker, desiredUsd, indicators, narrative, tranches, totalShares, totalCost };
}

export async function savePlan(payload: EntryPlanPayload): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO entry_plans (ticker, desired_position_usd, plan, status)
     VALUES ($1, $2, $3, 'draft') RETURNING id`,
    [payload.ticker, payload.desiredUsd, payload]
  );
  return rows[0].id;
}

export async function getPlan(planId: number): Promise<{ id: number; ticker: string; status: PlanStatus; plan: EntryPlanPayload } | null> {
  const rows = await query<{ id: number; ticker: string; status: PlanStatus; plan: EntryPlanPayload }>(
    `SELECT id, ticker, status, plan FROM entry_plans WHERE id = $1`,
    [planId]
  );
  return rows[0] ?? null;
}

/** Place all tranches as tagged GTC limit buys; persist entry_orders; mark plan staged. */
export async function stagePlan(planId: number, key: string, secret: string): Promise<EntryOrderRow[]> {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('Plan not found');
  if (plan.status !== 'draft') throw new Error(`Plan ${planId} is already ${plan.status}`);

  const out: EntryOrderRow[] = [];
  for (const t of plan.plan.tranches) {
    const clientOrderId = `s2-${plan.ticker}-${t.trancheN}`;
    const r = await placeGtcLimitBuy(key, secret, plan.ticker, t.shares, t.limitPrice, clientOrderId);
    await query(
      `INSERT INTO entry_orders (entry_plan_id, tranche_n, client_order_id, alpaca_order_id, shares, limit_price, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (client_order_id) DO UPDATE SET alpaca_order_id = EXCLUDED.alpaca_order_id, status = EXCLUDED.status`,
      [planId, t.trancheN, clientOrderId, r.id, t.shares, t.limitPrice, r.status]
    );
    out.push({ trancheN: t.trancheN, clientOrderId, alpacaOrderId: r.id, shares: t.shares, limitPrice: t.limitPrice, status: r.status });
  }
  await query(`UPDATE entry_plans SET status = 'staged' WHERE id = $1`, [planId]);
  return out;
}

/** Refresh each order's live Alpaca status into entry_orders and return current rows. */
export async function reconcilePlan(planId: number, key: string, secret: string): Promise<EntryOrderRow[]> {
  const rows = await query<EntryOrderRow & { alpaca_order_id: string | null; tranche_n: number; client_order_id: string; limit_price: number }>(
    `SELECT tranche_n, client_order_id, alpaca_order_id, shares, limit_price, status FROM entry_orders WHERE entry_plan_id = $1 ORDER BY tranche_n`,
    [planId]
  );
  const out: EntryOrderRow[] = [];
  for (const row of rows) {
    let status = row.status;
    if (row.alpaca_order_id) {
      const live = await getOrderById(key, secret, row.alpaca_order_id);
      if (live?.status) {
        status = live.status;
        await query(`UPDATE entry_orders SET status = $1 WHERE client_order_id = $2`, [status, row.client_order_id]);
      }
    }
    out.push({
      trancheN: row.tranche_n, clientOrderId: row.client_order_id, alpacaOrderId: row.alpaca_order_id,
      shares: Number(row.shares), limitPrice: Number(row.limit_price), status,
    });
  }
  return out;
}

/** Cancel all still-open orders for a plan; mark plan cancelled. */
export async function cancelRemaining(planId: number, key: string, secret: string): Promise<number> {
  const rows = await query<{ alpaca_order_id: string | null; status: string }>(
    `SELECT alpaca_order_id, status FROM entry_orders WHERE entry_plan_id = $1`,
    [planId]
  );
  let cancelled = 0;
  for (const r of rows) {
    if (r.alpaca_order_id && !['filled', 'canceled', 'cancelled', 'expired', 'rejected'].includes(r.status)) {
      if (await cancelOrder(key, secret, r.alpaca_order_id)) cancelled++;
    }
  }
  await query(`UPDATE entry_plans SET status = 'cancelled' WHERE id = $1`, [planId]);
  return cancelled;
}
```

- [ ] **Step 2: Type-check**

Run from `web-dashboard/`: `npx tsc --noEmit`. Expected: no errors from `entry-analysis.ts`.

- [ ] **Step 3: Commit**

```bash
git add web-dashboard/src/lib/research/entry-analysis.ts
git commit -m "feat(research): add entry analysis orchestrator + plan persistence"
```

---

## Task 7: Build-plan route

**Files:**
- Create: `web-dashboard/src/routes/api/research/entry/+server.ts`

- [ ] **Step 1: Implement**

Create `web-dashboard/src/routes/api/research/entry/+server.ts`:
```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { buildEntryAnalysis, savePlan } from '$lib/research/entry-analysis';

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const ticker = String(body.ticker ?? '').toUpperCase().trim();
  const desiredUsd = Number(body.desiredUsd);

  if (!ticker) return json({ error: 'Missing ticker' }, { status: 400 });
  if (!Number.isFinite(desiredUsd) || desiredUsd <= 0) {
    return json({ error: 'desiredUsd must be a positive number' }, { status: 400 });
  }

  const avKey = env.ALPHA_VANTAGE_API_KEY;
  const pplxKey = env.PERPLEXITY_API_KEY;
  if (!avKey || !pplxKey) return json({ error: 'Data API keys not configured' }, { status: 503 });

  try {
    const payload = await buildEntryAnalysis(ticker, desiredUsd, avKey, pplxKey);
    const planId = await savePlan(payload);
    return json({ planId, plan: payload });
  } catch (err) {
    console.error(`[research/entry] build failed for ${ticker}:`, err);
    return json({ error: `Failed to build entry plan for ${ticker}` }, { status: 500 });
  }
};
```

- [ ] **Step 2: Sync + type-check + build**

Run from `web-dashboard/`: `npx svelte-kit sync && npx tsc --noEmit && npm run build`. Expected: no new errors; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add web-dashboard/src/routes/api/research/entry/+server.ts
git commit -m "feat(research): add entry-plan build route"
```

---

## Task 8: Execute route (stage orders)

**Files:**
- Create: `web-dashboard/src/routes/api/research/entry/execute/+server.ts`

- [ ] **Step 1: Implement**

Create `web-dashboard/src/routes/api/research/entry/execute/+server.ts`:
```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getPlan, stagePlan } from '$lib/research/entry-analysis';

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const planId = Number(body.planId);
  if (!Number.isInteger(planId)) return json({ error: 'planId required' }, { status: 400 });

  const key = env.ALPACA_API_KEY;
  const secret = env.ALPACA_API_SECRET;
  if (!key || !secret) return json({ error: 'Alpaca not configured' }, { status: 503 });

  const plan = await getPlan(planId);
  if (!plan) return json({ error: 'Plan not found' }, { status: 404 });
  if (plan.status !== 'draft') return json({ error: `Plan already ${plan.status}` }, { status: 409 });

  // Safety: total cost must not exceed the desired position.
  if (plan.plan.totalCost > plan.plan.desiredUsd) {
    return json({ error: 'Plan total exceeds desired position' }, { status: 400 });
  }

  try {
    const orders = await stagePlan(planId, key, secret);
    return json({ planId, status: 'staged', orders });
  } catch (err) {
    console.error(`[research/entry/execute] plan ${planId} failed:`, err);
    return json({ error: 'Failed to stage orders' }, { status: 500 });
  }
};
```

- [ ] **Step 2: Sync + build**

Run from `web-dashboard/`: `npx svelte-kit sync && npm run build`. Expected: success.

- [ ] **Step 3: Commit**

```bash
git add web-dashboard/src/routes/api/research/entry/execute/+server.ts
git commit -m "feat(research): add confirm-gated order-staging route"
```

---

## Task 9: Status + cancel route

**Files:**
- Create: `web-dashboard/src/routes/api/research/entry/status/+server.ts`

- [ ] **Step 1: Implement**

Create `web-dashboard/src/routes/api/research/entry/status/+server.ts`:
```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { reconcilePlan, cancelRemaining } from '$lib/research/entry-analysis';

function alpacaKeys() {
  return { key: env.ALPACA_API_KEY, secret: env.ALPACA_API_SECRET };
}

export const GET: RequestHandler = async ({ url }) => {
  const planId = Number(url.searchParams.get('planId'));
  if (!Number.isInteger(planId)) return json({ error: 'planId required' }, { status: 400 });
  const { key, secret } = alpacaKeys();
  if (!key || !secret) return json({ error: 'Alpaca not configured' }, { status: 503 });
  try {
    const orders = await reconcilePlan(planId, key, secret);
    return json({ planId, orders });
  } catch (err) {
    console.error(`[research/entry/status] plan ${planId} failed:`, err);
    return json({ error: 'Failed to reconcile' }, { status: 500 });
  }
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const planId = Number(body.planId);
  if (!Number.isInteger(planId)) return json({ error: 'planId required' }, { status: 400 });
  const { key, secret } = alpacaKeys();
  if (!key || !secret) return json({ error: 'Alpaca not configured' }, { status: 503 });
  try {
    const cancelled = await cancelRemaining(planId, key, secret);
    return json({ planId, status: 'cancelled', cancelled });
  } catch (err) {
    console.error(`[research/entry/status] cancel plan ${planId} failed:`, err);
    return json({ error: 'Failed to cancel' }, { status: 500 });
  }
};
```

- [ ] **Step 2: Sync + build**

Run from `web-dashboard/`: `npx svelte-kit sync && npm run build`. Expected: success.

- [ ] **Step 3: Commit**

```bash
git add web-dashboard/src/routes/api/research/entry/status/+server.ts
git commit -m "feat(research): add entry order status + cancel-remaining route"
```

---

## Task 10: Entry Analysis page

**Files:**
- Create: `web-dashboard/src/routes/research/entry/+page.svelte`
- Modify: `web-dashboard/src/routes/research/+layout.svelte`

- [ ] **Step 1: Add the sub-nav link**

In `web-dashboard/src/routes/research/+layout.svelte`, add a second link inside the existing `<nav class="research-nav">` (after the Company Analysis link):
```svelte
  <a href="/research/entry">Entry Analysis</a>
```

- [ ] **Step 2: Create the page**

Create `web-dashboard/src/routes/research/entry/+page.svelte`:
```svelte
<script lang="ts">
  let ticker = $state('');
  let desiredUsd = $state(4000);
  let loading = $state(false);
  let error = $state('');
  let plan = $state<any>(null);
  let planId = $state<number | null>(null);
  let orders = $state<any[]>([]);
  let staging = $state(false);
  let confirming = $state(false);

  async function buildPlan() {
    if (!ticker.trim()) return;
    loading = true; error = ''; plan = null; planId = null; orders = []; confirming = false;
    try {
      const res = await fetch('/api/research/entry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: ticker.trim().toUpperCase(), desiredUsd }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      plan = data.plan; planId = data.planId;
    } catch (e: any) { error = e.message; }
    loading = false;
  }

  async function stage() {
    if (planId == null) return;
    staging = true; error = '';
    try {
      const res = await fetch('/api/research/entry/execute', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Staging failed');
      orders = data.orders; confirming = false;
    } catch (e: any) { error = e.message; }
    staging = false;
  }

  async function refreshStatus() {
    if (planId == null) return;
    const res = await fetch(`/api/research/entry/status?planId=${planId}`);
    const data = await res.json();
    if (res.ok) orders = data.orders;
  }

  async function cancelRemaining() {
    if (planId == null) return;
    const res = await fetch('/api/research/entry/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId }),
    });
    if (res.ok) await refreshStatus();
  }

  const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
</script>

<div class="page">
  <h1>Entry Analysis</h1>
  <p class="note">Stages GTC limit orders on the paper account (tagged <code>s2-</code>). Shares it with the auto-trader's positions.</p>

  <div class="search">
    <input placeholder="Ticker (e.g. AAPL)" bind:value={ticker} onkeydown={(e) => e.key === 'Enter' && buildPlan()} />
    <input type="number" min="100" step="100" bind:value={desiredUsd} />
    <button onclick={buildPlan} disabled={loading}>{loading ? 'Building…' : 'Build Plan'}</button>
  </div>

  {#if error}<p class="error">⚠ {error}</p>{/if}

  {#if plan}
    <div class="indicators">
      <span>Price {money(plan.indicators.currentPrice)}</span>
      <span>8/20/50d {plan.indicators.ma8?.toFixed(2) ?? '—'} / {plan.indicators.ma20?.toFixed(2) ?? '—'} / {plan.indicators.ma50?.toFixed(2) ?? '—'}</span>
      <span>52w {plan.indicators.low52w?.toFixed(2) ?? '—'}–{plan.indicators.high52w?.toFixed(2) ?? '—'}</span>
      <span>Rel vol {plan.indicators.relativeVolume?.toFixed(2) ?? '—'}x</span>
      <span>Volatility {plan.indicators.volatilityBand}</span>
    </div>

    <div class="narrative">
      <p><strong>Volume:</strong> {plan.narrative.volumeTrend}</p>
      <p><strong>Short interest:</strong> {plan.narrative.shortInterest}</p>
      <p><strong>Holders &amp; drivers:</strong> {plan.narrative.holdersAndDrivers}</p>
    </div>

    <h3>Entry plan — {plan.tranches.length} tranches, total {money(plan.totalCost)} of {money(plan.desiredUsd)}</h3>
    <table>
      <thead><tr><th>#</th><th>Shares</th><th>Limit</th><th>Cost</th><th>Rationale</th></tr></thead>
      <tbody>
        {#each plan.tranches as t}
          <tr><td>{t.trancheN}</td><td>{t.shares}</td><td>{money(t.limitPrice)}</td>
            <td>{money(t.shares * t.limitPrice)}</td><td class="rat">{t.rationale}</td></tr>
        {/each}
      </tbody>
    </table>

    {#if orders.length === 0}
      {#if !confirming}
        <button class="stage" onclick={() => (confirming = true)}>Stage these orders</button>
      {:else}
        <div class="confirm">
          <p>Place {plan.tranches.length} GTC limit buys totaling {money(plan.totalCost)} on the paper account?</p>
          <button class="stage" onclick={stage} disabled={staging}>{staging ? 'Placing…' : 'Confirm'}</button>
          <button onclick={() => (confirming = false)}>Cancel</button>
        </div>
      {/if}
    {:else}
      <h3>Staged orders</h3>
      <table>
        <thead><tr><th>#</th><th>Shares</th><th>Limit</th><th>Status</th><th>Alpaca ID</th></tr></thead>
        <tbody>
          {#each orders as o}
            <tr><td>{o.trancheN}</td><td>{o.shares}</td><td>{money(o.limitPrice)}</td>
              <td>{o.status}</td><td class="rat">{o.alpacaOrderId ?? '—'}</td></tr>
          {/each}
        </tbody>
      </table>
      <div class="actions">
        <button onclick={refreshStatus}>Refresh status</button>
        <button class="danger" onclick={cancelRemaining}>Cancel remaining</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .page { max-width: 1000px; margin: 0 auto; padding: 1.5rem; color: #e5e7eb; }
  h1 { margin-bottom: 0.25rem; }
  .note { color: #9ca3af; font-size: 0.85rem; margin-bottom: 1rem; }
  .note code { background: #1f2937; padding: 0 0.25rem; border-radius: 3px; }
  .search { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .search input[type="text"], .search input:not([type]) { flex: 1; }
  .search input { padding: 0.5rem; background: #111827; border: 1px solid #374151; color: #e5e7eb; border-radius: 6px; }
  .search input[type="number"] { width: 120px; }
  button { padding: 0.5rem 1rem; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; }
  button.danger { background: #b91c1c; }
  .indicators { display: flex; flex-wrap: wrap; gap: 1rem; font-size: 0.85rem; color: #d1d5db; margin-bottom: 0.75rem; }
  .narrative p { color: #d1d5db; font-size: 0.85rem; margin: 0.25rem 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin: 0.5rem 0 1rem; }
  th, td { padding: 0.4rem 0.5rem; border-bottom: 1px solid #1f2937; text-align: right; }
  th:first-child, td:first-child, td.rat { text-align: left; }
  td.rat { color: #9ca3af; font-size: 0.78rem; }
  .stage { background: #16a34a; }
  .confirm { display: flex; gap: 0.75rem; align-items: center; background: #0b2545; padding: 0.75rem; border-radius: 6px; }
  .confirm p { margin: 0; flex: 1; }
  .actions { display: flex; gap: 0.75rem; }
  .error { color: #f87171; }
</style>
```

- [ ] **Step 3: Sync + build**

Run from `web-dashboard/`: `npx svelte-kit sync && npm run build`. Expected: success; the Entry Analysis sub-nav link appears.

- [ ] **Step 4: Commit**

```bash
git add web-dashboard/src/routes/research/entry/+page.svelte web-dashboard/src/routes/research/+layout.svelte
git commit -m "feat(research): add Entry Analysis page + sub-nav link"
```

---

## Task 11: Full-suite check + final verification

**Files:** none (verification)

- [ ] **Step 1: Run the whole unit suite**

Run from `web-dashboard/`: `npm test`. Expected: Screen 1 (18) + price-series + entry-plan tests all pass, 0 failures.

- [ ] **Step 2: Full build**

Run from `web-dashboard/`: `npm run build`. Expected: success.

- [ ] **Step 3: Confirm migration 014 applied**

Run:
```bash
psql "$DATABASE_URL" -c "SELECT to_regclass('public.entry_plans'), to_regclass('public.entry_orders');"
```
Expected: both non-null.

- [ ] **Step 4: Note deploy + live-smoke as the combined Screen 1 + Screen 2 deploy step**

Deploy (`vercel --prod` from `web-dashboard/`) and the live paper-trade smoke test (build a plan for a real ticker, stage, verify orders appear in Alpaca, cancel remaining) are performed together with Screen 1 at deploy time — out of scope for the per-task commits here, handled by the controller after merge/approval.

---

## Self-Review

**Spec coverage (Screen 2 — §4/§5/§8 of the spec):**
- Inputs: ticker + desired $ (default $4,000) → Task 7 route + Task 10 UI ✓
- Time-series averages (8/20/50/52wk) → Task 3 `fetchIndicators` ✓
- Volume trends (computed rel-vol + Perplexity narrative) → Tasks 3 + 6 ✓
- Short interest (Perplexity) → Task 6 narrative ✓
- Holders & drivers (Perplexity) → Task 6 narrative ✓
- Deterministic ≤6 tranches, volatility-scaled, never above current price, every tranche a limit price, templated rationale → Task 4 `buildTranches` ✓
- Execution: confirm-gated; GTC limit buys placed natively; tagged `s2-<ticker>-<n>` → Tasks 8 + 5 + 10 ✓
- Persist plan + child orders; reconcile live status; cancel remaining → Tasks 1 + 6 + 9 + 10 ✓
- §5 tables `entry_plans` + `entry_orders` → Task 1 ✓
- §8 out-of-scope (no price-watching cron — native resting limits; no separate account; bot-interference accepted + surfaced in UI note) → honored ✓
- Execution safety: confirm gate, total ≤ desired, Alpaca-configured check, idempotent on `client_order_id` → Tasks 8 + 5 ✓

**Placeholder scan:** every code step has complete code; no TBD/TODO. ✓

**Type consistency:** `EntryInput`, `Tranche`, `Indicators`, `EntryPlanPayload`, `EntryNarrative`, `EntryOrderRow`, `PlanStatus` defined in Task 2 and used consistently by `entry-plan.ts` (4), `price-series.ts` (3), `entry-analysis.ts` (6), and routes (7/8/9). Function names — `fetchIndicators`, `buildTranches`, `buildEntryAnalysis`, `savePlan`, `getPlan`, `stagePlan`, `reconcilePlan`, `cancelRemaining`, `placeGtcLimitBuy`, `getOrderById`, `cancelOrder` — match across producer/consumer tasks. ✓

**Reused from Screen 1 (not rebuilt):** `perplexity.ts` (`askPerplexityJSON`, `JSON_SYSTEM_PROMPT`), `$lib/db` `query`, the AV fetch/`num` conventions. ✓
