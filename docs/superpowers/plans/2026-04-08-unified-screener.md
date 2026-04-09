# Unified Value + Catalyst Screener — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dual-tier (MOMENTUM/QUALITY) screener with a single unified value + catalyst screener across the full US equity universe, including attribution logging for post-trade analysis.

**Architecture:** Single pipeline path. Broadened Finviz sourcing + Yahoo `quoteSummary` for analyst targets. Composite score = 30% value + 35% catalyst + 25% upside - 15% risk. Attention demoted to tie-breaker. Six hard tradeability gates separate ranking from eligibility. Four entry categories drive category-specific max holds and fade rules. Conservative 10%/14% position sizing. Attribution columns on `trades` table from day one.

**Tech Stack:** Node.js + TypeScript 5.7 (backend), SvelteKit 2 + Svelte 5 (frontend), PostgreSQL 17 (Railway), Alpaca paper trading API, Perplexity (classifier), Finnhub (fundamentals), Yahoo Finance `quoteSummary` (analyst targets, NEW), Finviz (screener HTML scraping).

**Reference spec:** `docs/superpowers/specs/2026-04-08-unified-screener-design.md`

**Testing approach:** The backend has no test framework installed. We use **verification scripts** in `backend/src/scripts/` (e.g., `verify-scoring.ts`, `verify-yahoo.ts`) that exercise the new code against real or fixture data and assert expected outputs via `console.assert`. Run with `npx tsx src/scripts/<name>.ts`. These scripts stay in the repo for future debugging and regression checks. `tsc --noEmit` serves as the compile-time gate.

**Run prerequisite for local pipeline:** Do NOT use `railway run` (it injects unreachable `postgres.railway.internal`). Instead pass env vars explicitly:

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend && \
DATABASE_URL='postgresql://postgres:WMxIRbXdhNvmSMIBIayQYyfSXeATlQCE@switchyard.proxy.rlwy.net:15765/railway' \
ALPACA_API_KEY=PKFBKKMLIBQT2YLJMFKZMO5RU2 \
ALPACA_API_SECRET=63ycSwkU9tYKdC74X5Hj6tFcDAVhWivdCJsJVZa2sxyK \
ALPACA_PAPER=true \
ALPHA_VANTAGE_API_KEY=vAX02SJ9543I0E8F2 \
FINNHUB_API_KEY=<FINNHUB_API_KEY> \
MAX_TICKERS=20 \
PERPLEXITY_API_KEY=<PERPLEXITY_API_KEY> \
<COMMAND>
```

---

## File Structure

### New files

- `backend/src/services/yahoo.ts` — Yahoo `quoteSummary` client for analyst targets and valuation metrics. **Exported:** `fetchQuoteSummary(ticker): Promise<YahooQuoteSummary | null>`.
- `backend/src/services/sectorMedians.ts` — Static const map of P/E and P/B medians per sector. **Exported:** `getSectorMedianPE(sector)`, `getSectorMedianPB(sector)`.
- `backend/src/lib/tradeability.ts` — Six hard gate functions. **Exported:** `evaluateTradeability(analysis): { tradeable, failures }`.
- `backend/src/services/categoryClassification.ts` — Entry-category determination for trader. **Exported:** `determineEntryCategory(analysis): { category, catalystType, catalystDate }`, `CATEGORY_MAX_HOLD_DAYS` const map.
- `backend/src/scripts/verify-*.ts` — Verification scripts (one per major unit).
- `database/migration-009-unified-screener.sql` — Additive-only DDL.

### Modified files (substantial)

- `backend/src/types/index.ts` — New types: `ComponentScores`, `EntryCategory`, `CatalystType`, `UnifiedClassification`, `TradeabilityResult`, `YahooQuoteSummary`, `EntryAttribution`, `ExitAttribution`. Keep `Tier` and `DualTierClassificationResult` exports for backward compat.
- `backend/src/services/scoring.ts` — Near-total rewrite. New exports: `calculateValueScore`, `calculateCatalystScore`, `calculateUpsideScore`, `calculateRiskScore`, `calculateCompositeScore`, `classifyTicker` (updated return type).
- `backend/src/services/classifier.ts` — New Perplexity prompt and response schema. New return type `UnifiedClassification`.
- `backend/src/services/trader.ts` — Uniform sizing, category determination, category-specific holds, fade rules, entry attribution in `evaluateBuy`, exit attribution in `evaluateSell` + `reconcilePendingOrders`.
- `backend/src/services/finviz.ts` — Replace 4 penny queries with 6 new queries. Drop hardcoded `<$10`.
- `backend/src/services/finnhub.ts` — Wire `fetchInsiderTransactions` into `enrichForClassifier`.
- `backend/src/pipeline.ts` — Collapse dual-tier functions into single-path equivalents. Add pre-rank step. Write new attribution columns in save site.

### Modified files (small)

- `web-dashboard/src/routes/+page.svelte` — Remove tier badge, add BUY/WATCH/AVOID, add tradeable indicator, component scores.
- `web-dashboard/src/routes/ticker/[symbol]/+page.svelte` — Thesis hero for new classifier output.
- `web-dashboard/src/routes/portfolio/+page.svelte` — AI Trades tab: add entry_category and component scores columns.
- `web-dashboard/src/routes/analytics/+page.svelte` — Add Attribution tab.
- `web-dashboard/src/lib/db.ts` — Add new columns to `ScanResult` and `TradeRecord` interfaces.

---

# PHASE A — FOUNDATIONS (purely additive, no behavior change)

## Task A1: Database migration 009

**Files:**
- Create: `database/migration-009-unified-screener.sql`

- [ ] **Step 1: Create migration file**

```sql
-- migration-009-unified-screener.sql
-- Adds attribution logging to trades, portfolio_state category tracking,
-- and tradeability metadata on scan_results.
-- Additive-only. Safe to run on live DB.

BEGIN;

-- Attribution logging on trades
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS entry_value_score    INT,
  ADD COLUMN IF NOT EXISTS entry_catalyst_score INT,
  ADD COLUMN IF NOT EXISTS entry_upside_score   INT,
  ADD COLUMN IF NOT EXISTS entry_risk_score     INT,
  ADD COLUMN IF NOT EXISTS entry_composite      INT,
  ADD COLUMN IF NOT EXISTS entry_category       TEXT,
  ADD COLUMN IF NOT EXISTS entry_catalyst_type  TEXT,
  ADD COLUMN IF NOT EXISTS entry_catalyst_date  DATE,
  ADD COLUMN IF NOT EXISTS exit_value_score     INT,
  ADD COLUMN IF NOT EXISTS exit_catalyst_score  INT,
  ADD COLUMN IF NOT EXISTS exit_upside_score    INT,
  ADD COLUMN IF NOT EXISTS exit_risk_score      INT,
  ADD COLUMN IF NOT EXISTS exit_composite       INT,
  ADD COLUMN IF NOT EXISTS exit_reason          TEXT;

-- Category tracking on portfolio_state for sell evaluation
ALTER TABLE portfolio_state
  ADD COLUMN IF NOT EXISTS entry_category      TEXT,
  ADD COLUMN IF NOT EXISTS entry_catalyst_date DATE;

-- Tradeability metadata on scan_results
ALTER TABLE scan_results
  ADD COLUMN IF NOT EXISTS tradeable     BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS gate_failures TEXT[];

COMMIT;
```

- [ ] **Step 2: Apply to local (prod proxy) DB**

Run:
```bash
cd backend && cat > /tmp/apply-009.ts <<'EOF'
import { Pool } from 'pg';
import fs from 'fs';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const sql = fs.readFileSync('../database/migration-009-unified-screener.sql', 'utf8');
  await pool.query(sql);
  const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='trades' AND column_name LIKE 'entry_%' OR column_name LIKE 'exit_%' ORDER BY column_name");
  console.log('trades columns:', cols.rows.map(r => r.column_name));
  await pool.end();
})();
EOF
DATABASE_URL='postgresql://postgres:WMxIRbXdhNvmSMIBIayQYyfSXeATlQCE@switchyard.proxy.rlwy.net:15765/railway' npx tsx /tmp/apply-009.ts
rm /tmp/apply-009.ts
```

Expected output: list of 14 entry_* / exit_* columns.

- [ ] **Step 3: Commit**

```bash
git add database/migration-009-unified-screener.sql
git commit -m "feat: migration-009 attribution + tradeability columns"
```

---

## Task A2: New types in `types/index.ts`

**Files:**
- Modify: `backend/src/types/index.ts`

- [ ] **Step 1: Add new type exports (append to end of file, do not touch existing types)**

```typescript
// ── Unified Screener Types (2026-04-08) ────────────────

export type EntryCategory =
  | 'earnings_event'
  | 'insider_signal'
  | 'value_rerating'
  | 'attention_momentum';

export interface ComponentScores {
  value: number;      // 0-100
  catalyst: number;   // 0-100
  upside: number;     // 0-100
  risk: number;       // 0-100 (higher = worse)
  attention: number;  // 0-100 (tie-breaker only)
  composite: number;  // ~-15 to 90
}

export interface TradeabilityResult {
  tradeable: boolean;
  failures: string[]; // e.g., ['price_lt_2', 'no_analyst_coverage']
}

export interface YahooQuoteSummary {
  ticker: string;
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  numberOfAnalystOpinions: number;
  recommendationMean: number | null; // 1=Strong Buy, 5=Strong Sell
  trailingPE: number | null;
  forwardPE: number | null;
  priceToBook: number | null;
  priceToSales: number | null;
  high52w: number | null;
  low52w: number | null;
}

export interface UnifiedClassification {
  thesis: string;
  valueCase: string;
  catalysts: Array<{ description: string; date: string | null }>;
  keyRisks: string[];
  expectedReturn30d: number;
  convictionScore: number; // 0-10
  recommendation: 'BUY' | 'WATCH' | 'AVOID';
}

export interface EntryAttribution {
  valueScore: number;
  catalystScore: number;
  upsideScore: number;
  riskScore: number;
  composite: number;
  category: EntryCategory;
  catalystType: string;
  catalystDate: string | null; // YYYY-MM-DD
}

export interface ExitAttribution {
  valueScore: number;
  catalystScore: number;
  upsideScore: number;
  riskScore: number;
  composite: number;
  reason: 'stop_loss' | 'catalyst_fade' | 'max_hold' | 'reclass_avoid' | 'scan_miss' | 'manual';
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/types/index.ts
git commit -m "feat: add unified screener types"
```

---

## Task A3: Sector medians constant

**Files:**
- Create: `backend/src/services/sectorMedians.ts`

- [ ] **Step 1: Write the module**

```typescript
// backend/src/services/sectorMedians.ts
/**
 * Static sector median P/E and P/B ratios used for relative valuation scoring.
 * These are reasonable defaults as of 2026. Not real-time — updated manually.
 */

interface SectorMedians {
  pe: number;
  pb: number;
}

const SECTOR_MEDIANS: Record<string, SectorMedians> = {
  'Technology':              { pe: 25, pb: 4.0 },
  'Consumer Discretionary':  { pe: 22, pb: 3.0 },
  'Healthcare':              { pe: 20, pb: 3.5 },
  'Communication Services':  { pe: 20, pb: 3.0 },
  'Industrials':             { pe: 18, pb: 2.5 },
  'Real Estate':             { pe: 20, pb: 2.0 },
  'Consumer Staples':        { pe: 20, pb: 3.5 },
  'Materials':               { pe: 15, pb: 2.0 },
  'Utilities':               { pe: 18, pb: 1.8 },
  'Energy':                  { pe: 10, pb: 1.5 },
  'Financials':              { pe: 12, pb: 1.2 },
  'Financial Services':      { pe: 12, pb: 1.2 },
};

const DEFAULT_MEDIANS: SectorMedians = { pe: 18, pb: 2.5 };

function normalize(sector: string): string {
  return (sector || '').trim();
}

export function getSectorMedianPE(sector: string): number {
  return (SECTOR_MEDIANS[normalize(sector)] ?? DEFAULT_MEDIANS).pe;
}

export function getSectorMedianPB(sector: string): number {
  return (SECTOR_MEDIANS[normalize(sector)] ?? DEFAULT_MEDIANS).pb;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/sectorMedians.ts
git commit -m "feat: add static sector median P/E and P/B constants"
```

---

## Task A4: Yahoo `quoteSummary` service

**Files:**
- Create: `backend/src/services/yahoo.ts`
- Create: `backend/src/scripts/verify-yahoo.ts`

- [ ] **Step 1: Write the service**

```typescript
// backend/src/services/yahoo.ts
import { sleep } from '../lib/http.js';
import type { YahooQuoteSummary } from '../types/index.js';

const BASE = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary';
const MODULES = 'financialData,defaultKeyStatistics,summaryDetail';

// Yahoo throttles aggressively; keep a small inter-call delay
let lastCallAt = 0;
const MIN_GAP_MS = 250;

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  // Yahoo sometimes wraps values in { raw, fmt, longFmt }
  if (typeof v === 'object' && v !== null && 'raw' in v) {
    const raw = (v as { raw: unknown }).raw;
    return typeof raw === 'number' && isFinite(raw) ? raw : null;
  }
  return null;
}

export async function fetchQuoteSummary(ticker: string): Promise<YahooQuoteSummary | null> {
  try {
    const now = Date.now();
    const wait = Math.max(0, lastCallAt + MIN_GAP_MS - now);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();

    const url = `${BASE}/${encodeURIComponent(ticker)}?modules=${MODULES}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[Yahoo] ${ticker} HTTP ${res.status}`);
      return null;
    }

    const json = await res.json() as { quoteSummary?: { result?: Array<Record<string, Record<string, unknown>>> } };
    const result = json?.quoteSummary?.result?.[0];
    if (!result) return null;

    const fd = result.financialData ?? {};
    const dks = result.defaultKeyStatistics ?? {};
    const sd = result.summaryDetail ?? {};

    return {
      ticker,
      targetMeanPrice:         num(fd.targetMeanPrice),
      targetHighPrice:         num(fd.targetHighPrice),
      targetLowPrice:          num(fd.targetLowPrice),
      numberOfAnalystOpinions: num(fd.numberOfAnalystOpinions) ?? 0,
      recommendationMean:      num(fd.recommendationMean),
      trailingPE:              num(sd.trailingPE),
      forwardPE:               num(sd.forwardPE),
      priceToBook:             num(dks.priceToBook),
      priceToSales:            num(sd.priceToSalesTrailing12Months),
      high52w:                 num(sd.fiftyTwoWeekHigh),
      low52w:                  num(sd.fiftyTwoWeekLow),
    };
  } catch (err) {
    console.warn(`[Yahoo] ${ticker} fetch failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export default { fetchQuoteSummary };
```

- [ ] **Step 2: Write verification script**

```typescript
// backend/src/scripts/verify-yahoo.ts
import { fetchQuoteSummary } from '../services/yahoo.js';

(async () => {
  const tickers = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'F'];
  for (const t of tickers) {
    const result = await fetchQuoteSummary(t);
    console.log(t, '→', result ? {
      target: result.targetMeanPrice,
      analysts: result.numberOfAnalystOpinions,
      pe: result.trailingPE,
      pb: result.priceToBook,
    } : 'null');
    console.assert(result !== null, `${t} should return data`);
    console.assert(result && result.numberOfAnalystOpinions > 0, `${t} should have analyst coverage`);
  }
  console.log('verify-yahoo: OK');
})();
```

- [ ] **Step 3: Run verification script**

Run:
```bash
cd backend && npx tsx src/scripts/verify-yahoo.ts
```
Expected: each ticker prints with non-null `target`, `analysts ≥ 5`, `pe` present, `pb` present. Final line: `verify-yahoo: OK`.

- [ ] **Step 4: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/yahoo.ts backend/src/scripts/verify-yahoo.ts
git commit -m "feat: add Yahoo quoteSummary service for analyst targets + valuation"
```

---

## Task A5: Tradeability gates library

**Files:**
- Create: `backend/src/lib/tradeability.ts`

- [ ] **Step 1: Write the module**

```typescript
// backend/src/lib/tradeability.ts
/**
 * Hard tradeability gates. A ticker must pass ALL gates to be trader-eligible.
 * Failing gates still appear in scan_results with their composite score —
 * they're just marked tradeable=false and skipped by the trader.
 */

import type {
  PriceData,
  FundamentalData,
  ClassifierEnrichment,
  YahooQuoteSummary,
  TradeabilityResult,
} from '../types/index.js';

const MIN_PRICE = 2.00;
const MIN_MARKET_CAP = 300_000_000;           // $300M
const MIN_DOLLAR_VOLUME = 5_000_000;          // $5M/day
const MIN_ANALYST_COUNT = 2;
const EARNINGS_BLACKOUT_HOURS = 24;

export interface TradeabilityInputs {
  price: PriceData;
  fundamentals: FundamentalData;
  yahoo: YahooQuoteSummary | null;
  enrichment: ClassifierEnrichment | undefined;
}

export function evaluateTradeability(inputs: TradeabilityInputs): TradeabilityResult {
  const failures: string[] = [];
  const { price, fundamentals, yahoo, enrichment } = inputs;

  // Gate 1: price ≥ $2.00
  if (!price.price || price.price < MIN_PRICE) {
    failures.push('price_lt_2');
  }

  // Gate 2: market cap ≥ $300M
  if (!fundamentals.marketCap || fundamentals.marketCap < MIN_MARKET_CAP) {
    failures.push('market_cap_lt_300m');
  }

  // Gate 3: avg daily dollar volume ≥ $5M
  const dollarVolume = (price.price || 0) * (price.avgVolume30d || 0);
  if (dollarVolume < MIN_DOLLAR_VOLUME) {
    failures.push('dollar_volume_lt_5m');
  }

  // Gate 4: analyst coverage ≥ 2
  const analystCount = yahoo?.numberOfAnalystOpinions ?? 0;
  if (analystCount < MIN_ANALYST_COUNT) {
    failures.push('no_analyst_coverage');
  }

  // Gate 5: US-listed, not ETF/ADR
  // exchange and country checks — fundamentals carries these
  const country = (fundamentals.country || '').toUpperCase();
  if (country && country !== 'US') {
    failures.push('not_us_listed');
  }
  // ETF detection: Finnhub profile2 leaves industry blank for ETFs; also check name
  const nameUpper = (fundamentals.name || '').toUpperCase();
  if (nameUpper.includes(' ETF') || nameUpper.includes('SHARES ') || nameUpper.includes('TRUST')) {
    failures.push('is_etf_or_trust');
  }

  // Gate 6: earnings not imminent (within 24 hours either direction)
  const daysToEarnings = enrichment?.earnings?.daysToEarnings;
  if (typeof daysToEarnings === 'number' && Math.abs(daysToEarnings) * 24 < EARNINGS_BLACKOUT_HOURS) {
    failures.push('earnings_imminent');
  }

  return { tradeable: failures.length === 0, failures };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/lib/tradeability.ts
git commit -m "feat: add tradeability hard-gate library"
```

---

# PHASE B — SCORING REWRITE (still no behavior change — pipeline not switched over yet)

## Task B1: Rewrite `scoring.ts` — component score functions

**Files:**
- Modify: `backend/src/services/scoring.ts` (near-total rewrite)
- Create: `backend/src/scripts/verify-scoring.ts`

**IMPORTANT:** keep the old `calculateAttentionScore`, `calculateMomentumScore`, `calculateFundamentalsScore`, `calculateRiskScore`, `calculateAllScores`, `classifyTicker` exports as-is for now (the old pipeline still imports them). Add the NEW functions alongside. The old pipeline will be switched over in Phase D and the old functions removed in Phase G (cleanup).

- [ ] **Step 1: Add new component-score functions to scoring.ts**

Append to `backend/src/services/scoring.ts` (keeping existing code above):

```typescript
// ── Unified Screener Scoring (2026-04-08) ──────────────

import type {
  ComponentScores,
  YahooQuoteSummary,
  ClassifierEnrichment,
} from '../types/index.js';
import type { TechnicalIndicators } from './technicals.js';
import { getSectorMedianPE, getSectorMedianPB } from './sectorMedians.js';

interface UnifiedScoringInputs {
  sentiment: MergedSentiment;
  price: PriceData;
  fundamentals: FundamentalData;
  yahoo: YahooQuoteSummary | null;
  enrichment: ClassifierEnrichment | undefined;
  technicals: TechnicalIndicators | null;
  finvizHits: number;  // number of distinct Finviz sub-screens this ticker appeared in
  insiderLargeBuy90d: boolean;
  insiderAnyBuy90d: boolean;
  insiderNetSelling: boolean;
}

/**
 * Value score (0-100). Answer: is this mispriced?
 */
export function calculateValueScore(input: UnifiedScoringInputs): number {
  const { price, fundamentals, yahoo } = input;
  let score = 0;

  // Analyst target upside (0-25)
  if (yahoo?.targetMeanPrice && price.price > 0) {
    const upsidePct = ((yahoo.targetMeanPrice - price.price) / price.price) * 100;
    if (upsidePct >= 50) score += 25;
    else if (upsidePct >= 30) score += 18;
    else if (upsidePct >= 15) score += 12;
    else if (upsidePct >= 5) score += 6;
    // else 0
  }

  // Forward revenue growth (0-15)
  const revGrowth = fundamentals.revenueGrowth;
  if (typeof revGrowth === 'number') {
    if (revGrowth >= 0.20) score += 15;
    else if (revGrowth >= 0.10) score += 10;
    else if (revGrowth >= 0.05) score += 6;
    else if (revGrowth >= 0) score += 2;
    // negative = 0
  }

  // Gross margin level (0-10)
  const gm = fundamentals.grossMargin;
  if (typeof gm === 'number') {
    if (gm >= 0.50) score += 10;
    else if (gm >= 0.35) score += 7;
    else if (gm >= 0.20) score += 4;
    // below = 0
  }

  // Operating margin (0-10)
  const om = fundamentals.operatingMargin;
  if (typeof om === 'number') {
    if (om >= 0.20) score += 10;
    else if (om >= 0.10) score += 6;
    else if (om >= 0.05) score += 3;
    // below = 0
  }

  // P/E vs sector median (0-20)
  const pe = fundamentals.peRatio;
  if (typeof pe === 'number' && pe > 0) {
    const sectorPE = getSectorMedianPE(fundamentals.sector);
    const discount = (sectorPE - pe) / sectorPE;
    if (discount >= 0.3) score += 20;
    else if (discount >= 0.15) score += 12;
    else if (discount >= 0) score += 6;
    // premium = 0
  }

  // P/B vs sector median (0-10)
  const pb = fundamentals.pbRatio;
  if (typeof pb === 'number' && pb > 0) {
    const sectorPB = getSectorMedianPB(fundamentals.sector);
    const discount = (sectorPB - pb) / sectorPB;
    if (discount >= 0.3) score += 10;
    else if (discount >= 0.15) score += 6;
    else if (discount >= 0) score += 3;
  }

  // Distance from 52w high (0-10)
  if (price.high52w > 0 && price.price > 0) {
    const distancePct = ((price.high52w - price.price) / price.high52w) * 100;
    if (distancePct >= 50) score += 10;
    else if (distancePct >= 30) score += 7;
    else if (distancePct >= 15) score += 4;
    // near high = 0
  }

  return Math.min(100, Math.round(score));
}

/**
 * Catalyst score (0-100). Answer: is something about to happen?
 */
export function calculateCatalystScoreV2(input: UnifiedScoringInputs): number {
  const { enrichment, insiderLargeBuy90d, insiderAnyBuy90d, insiderNetSelling } = input;
  let score = 0;

  // Days to next earnings (0-30)
  const dte = enrichment?.earnings?.daysToEarnings;
  if (typeof dte === 'number' && dte >= 0) {
    if (dte <= 5) score += 30;
    else if (dte <= 10) score += 25;
    else if (dte <= 20) score += 15;
    else if (dte <= 35) score += 8;
  }

  // Beat rate (0-20)
  const beatRate = enrichment?.earnings?.earningsBeatRate;
  if (typeof beatRate === 'number') {
    if (beatRate >= 100) score += 20;         // 4/4
    else if (beatRate >= 75) score += 15;     // 3/4
    else if (beatRate >= 50) score += 10;     // 2/4
    // else 0
  }

  // Analyst recommendation (0-20) — from enrichment.analystRatings.summary (parsed)
  const summary = enrichment?.analystRatings?.summary ?? '';
  const strongBuyMatch = /Strong Buy:\s*(\d+)/i.exec(summary);
  const buyMatch = /(?<!Strong )Buy:\s*(\d+)/i.exec(summary);
  const strongBuyCount = strongBuyMatch ? parseInt(strongBuyMatch[1]) : 0;
  const buyCount = buyMatch ? parseInt(buyMatch[1]) : 0;
  const positiveCount = strongBuyCount + buyCount;
  if (strongBuyCount >= 3) score += 20;
  else if (strongBuyCount >= 1 || positiveCount >= 4) score += 15;
  else if (positiveCount >= 2) score += 8;

  // Insider buying (0-20)
  if (insiderLargeBuy90d) score += 20;
  else if (insiderAnyBuy90d) score += 10;
  else if (insiderNetSelling) score -= 5; // penalty capped by clamp below

  // News recency (0-10)
  const headlines = enrichment?.newsHeadlines ?? [];
  if (headlines.length >= 3) score += 10;
  else if (headlines.length >= 1) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Upside/technical score (0-100). Tailwinds?
 */
export function calculateUpsideScore(input: UnifiedScoringInputs): number {
  const { price, technicals, finvizHits } = input;
  let score = 0;

  // Relative volume (0-25)
  const rv = price.relativeVolume ?? 1;
  if (rv >= 3) score += 25;
  else if (rv >= 2) score += 18;
  else if (rv >= 1.5) score += 10;
  else if (rv >= 1) score += 5;

  // 30d price momentum (0-25)
  const mom30 = price.change30dPercent ?? 0;
  if (mom30 >= 20) score += 25;
  else if (mom30 >= 10) score += 18;
  else if (mom30 >= 0) score += 10;
  else if (mom30 >= -10) score += 5;

  // RSI in healthy zone (0-15): 35-65 is sweet spot, avoid overbought/oversold
  const rsi = technicals?.rsi14;
  if (typeof rsi === 'number') {
    if (rsi >= 40 && rsi <= 60) score += 15;
    else if (rsi >= 35 && rsi <= 65) score += 10;
    else if (rsi >= 30 && rsi <= 70) score += 5;
  }

  // Technical signal bullish (0-20)
  const sig = technicals?.technicalSignal;
  if (sig === 'strong_buy' || sig === 'buy') score += 20;
  else if (sig === 'neutral') score += 8;

  // Multi-screen hits (0-15)
  if (finvizHits >= 3) score += 15;
  else if (finvizHits === 2) score += 10;
  else if (finvizHits === 1) score += 4;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Risk score (0-100, HIGHER = WORSE).
 * Items that are also hard gates (micro-cap, no analyst, sub-$2) are NOT
 * scored here — they block entry in tradeability.ts before this runs.
 */
export function calculateRiskScoreV2(input: UnifiedScoringInputs): number {
  const { fundamentals, yahoo } = input;
  let score = 15; // base

  // Debt/equity high
  const de = fundamentals.debtEquity;
  if (typeof de === 'number') {
    if (de > 2.0) score += 25;
    else if (de > 1.0) score += 12;
  }

  // Negative or zero revenue growth
  const rg = fundamentals.revenueGrowth;
  if (typeof rg === 'number') {
    if (rg < -0.10) score += 20;
    else if (rg <= 0) score += 10;
  }

  // Small cap ($300M-$2B) → moderate penalty
  const mc = fundamentals.marketCap;
  if (typeof mc === 'number' && mc < 2_000_000_000 && mc >= 300_000_000) {
    score += 15;
  }

  // Negative operating margin
  const om = fundamentals.operatingMargin;
  if (typeof om === 'number' && om < 0) {
    score += 15;
  }

  // Mild analyst coverage (passed gate but thin)
  const analysts = yahoo?.numberOfAnalystOpinions ?? 0;
  if (analysts < 5) score += 10;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Attention score (tie-breaker only, NOT part of composite)
 */
export function calculateAttentionScoreV2(sentiment: MergedSentiment): number {
  const src = sentiment.sources;
  const apeRank = src['apewisdom-penny']?.rank
    ?? src['apewisdom-all']?.rank
    ?? src['apewisdom-wsb']?.rank
    ?? 999;
  const stMentions = src.stocktwits?.mentions ?? 0;
  const finvizHits = [src.finviz].filter(Boolean).length;

  let score = 0;
  if (apeRank <= 10) score += 40;
  else if (apeRank <= 50) score += 25;
  else if (apeRank <= 100) score += 10;
  if (stMentions > 1000) score += 20;
  else if (stMentions > 100) score += 10;
  score += finvizHits * 10;
  return Math.min(100, score);
}

/**
 * Composite score with weights from spec:
 * composite = 0.30*value + 0.35*catalyst + 0.25*upside - 0.15*risk
 * Attention is NOT included.
 */
export function calculateCompositeScore(
  value: number,
  catalyst: number,
  upside: number,
  risk: number
): number {
  const composite = 0.30 * value + 0.35 * catalyst + 0.25 * upside - 0.15 * risk;
  return Math.round(composite);
}

/**
 * Build the full ComponentScores object from unified inputs.
 */
export function calculateAllUnifiedScores(input: UnifiedScoringInputs): ComponentScores {
  const value = calculateValueScore(input);
  const catalyst = calculateCatalystScoreV2(input);
  const upside = calculateUpsideScore(input);
  const risk = calculateRiskScoreV2(input);
  const attention = calculateAttentionScoreV2(input.sentiment);
  const composite = calculateCompositeScore(value, catalyst, upside, risk);
  return { value, catalyst, upside, risk, attention, composite };
}

/**
 * Classification based on composite + risk + tradeability.
 * Replaces runner/value/both/avoid/watch with BUY/WATCH/AVOID.
 */
export function classifyUnified(
  scores: ComponentScores,
  tradeable: boolean
): 'BUY' | 'WATCH' | 'AVOID' {
  if (scores.composite < 50 || scores.risk > 60) return 'AVOID';
  if (scores.composite >= 65 && scores.risk <= 45 && tradeable) return 'BUY';
  return 'WATCH';
}
```

- [ ] **Step 2: Write verification script**

```typescript
// backend/src/scripts/verify-scoring.ts
import {
  calculateValueScore,
  calculateCatalystScoreV2,
  calculateUpsideScore,
  calculateRiskScoreV2,
  calculateCompositeScore,
  calculateAllUnifiedScores,
  classifyUnified,
} from '../services/scoring.js';
import type { PriceData, FundamentalData, MergedSentiment, YahooQuoteSummary, ClassifierEnrichment } from '../types/index.js';

// Fixture: a "good" value+catalyst candidate
const goodPrice: PriceData = {
  ticker: 'TEST',
  price: 40,
  change1d: 0, change1dPercent: 0,
  change5d: 0, change5dPercent: 0,
  change30d: 5, change30dPercent: 12,
  volume: 2_000_000,
  avgVolume30d: 1_500_000,
  relativeVolume: 1.8,
  high52w: 70, low52w: 35,
  timestamp: new Date(),
};
const goodFund: FundamentalData = {
  ticker: 'TEST', name: 'Test Co', sector: 'Technology', industry: 'Software',
  exchange: 'NASDAQ', country: 'US', marketCap: 5_000_000_000, sharesOutstanding: 125_000_000,
  peRatio: 15, psRatio: 2.5, pbRatio: 2.5,
  epsGrowth: null, revenueGrowth: 0.15, grossMargin: 0.55, operatingMargin: 0.18,
  debtEquity: 0.5, recentFilings: 0, timestamp: new Date(),
};
const goodYahoo: YahooQuoteSummary = {
  ticker: 'TEST', targetMeanPrice: 60, targetHighPrice: 70, targetLowPrice: 50,
  numberOfAnalystOpinions: 8, recommendationMean: 2.0,
  trailingPE: 15, forwardPE: 13, priceToBook: 2.5, priceToSales: 2.5,
  high52w: 70, low52w: 35,
};
const goodEnrich: ClassifierEnrichment = {
  analystRatings: { summary: 'Strong Buy: 4, Buy: 3, Hold: 1', meanTarget: 60, highTarget: 70, lowTarget: 50 },
  earnings: { nextDate: '2026-04-15', daysToEarnings: 7, epsEstimate: 1.2, earningsBeatRate: 75 },
  newsHeadlines: ['h1', 'h2', 'h3'],
};
const goodSentiment: MergedSentiment = {
  ticker: 'TEST', totalMentions: 50, avgSentiment: 60, maxMomentum: 1.5,
  sourceCount: 3, sources: {},
};

const goodInput = {
  sentiment: goodSentiment, price: goodPrice, fundamentals: goodFund,
  yahoo: goodYahoo, enrichment: goodEnrich, technicals: null,
  finvizHits: 2, insiderLargeBuy90d: true, insiderAnyBuy90d: true, insiderNetSelling: false,
};

const good = calculateAllUnifiedScores(goodInput);
console.log('GOOD candidate:', good);
console.assert(good.value >= 60, `good value should be ≥60, got ${good.value}`);
console.assert(good.catalyst >= 60, `good catalyst should be ≥60, got ${good.catalyst}`);
console.assert(good.composite >= 55, `good composite should be ≥55, got ${good.composite}`);
console.assert(classifyUnified(good, true) === 'BUY', `should classify as BUY`);

// Fixture: a "junk" ticker
const junkInput = {
  ...goodInput,
  price: { ...goodPrice, price: 8, high52w: 8, change30dPercent: -15, relativeVolume: 0.5 },
  fundamentals: { ...goodFund, marketCap: 400_000_000, revenueGrowth: -0.10, grossMargin: 0.10, operatingMargin: -0.05, peRatio: 50, pbRatio: 10, debtEquity: 3.0 },
  yahoo: { ...goodYahoo, targetMeanPrice: 7, numberOfAnalystOpinions: 2 },
  enrichment: { ...goodEnrich, earnings: { nextDate: null, daysToEarnings: null, epsEstimate: null, earningsBeatRate: 0 } },
  insiderLargeBuy90d: false, insiderAnyBuy90d: false, insiderNetSelling: true,
  finvizHits: 0,
};
const junk = calculateAllUnifiedScores(junkInput);
console.log('JUNK candidate:', junk);
console.assert(junk.composite < 40, `junk composite should be <40, got ${junk.composite}`);
console.assert(classifyUnified(junk, true) === 'AVOID', `should classify as AVOID`);

console.log('verify-scoring: OK');
```

- [ ] **Step 3: Run verification**

Run: `cd backend && npx tsx src/scripts/verify-scoring.ts`
Expected: prints component scores for both fixtures, all assertions pass, ends with `verify-scoring: OK`.

- [ ] **Step 4: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/scoring.ts backend/src/scripts/verify-scoring.ts
git commit -m "feat: add unified value/catalyst/upside/risk scoring functions"
```

---

# PHASE C — SOURCE + ENRICHMENT WIRING

## Task C1: Rewrite Finviz service with 6 new queries

**Files:**
- Modify: `backend/src/services/finviz.ts`

- [ ] **Step 1: Replace the 4 fetch functions + `fetchAllFinvizSignals`**

Replace the entire file contents with:

```typescript
// backend/src/services/finviz.ts
/**
 * Finviz Screener Service — unified screener (2026-04-08)
 * Six queries spanning the full universe (no price cap):
 * 1. Value setups        — low P/E, low P/B, liquid
 * 2. Analyst upgrades    — Buy or better
 * 3. Earnings catalysts  — earnings in next 5 days
 * 4. Insider buying      — recent large positive insider transactions
 * 5. Unusual volume      — >2x relative volume
 * 6. Oversold bounce     — RSI<30 + current ratio > 1
 */

type FinvizSource =
  | 'value_setup' | 'analyst_upgrade' | 'earnings_catalyst'
  | 'insider_buying' | 'unusual_volume' | 'oversold_bounce';

interface FinvizTicker {
  ticker: string;
  company: string;
  source: FinvizSource;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function parseFinvizHtml(html: string): string[] {
  const tickers: string[] = [];
  const seen = new Set<string>();
  const primary = /<a[^>]*href="quote\.ashx\?t=([A-Z.]{1,6})"[^>]*class="screener-link-primary"/gi;
  let m: RegExpExecArray | null;
  while ((m = primary.exec(html)) !== null) {
    const t = m[1].toUpperCase();
    if (!seen.has(t)) { seen.add(t); tickers.push(t); }
  }
  // Fallback: any quote.ashx link
  const fallback = /quote\.ashx\?t=([A-Z.]{1,6})(?:&|")/gi;
  while ((m = fallback.exec(html)) !== null) {
    const t = m[1].toUpperCase();
    if (!seen.has(t)) { seen.add(t); tickers.push(t); }
  }
  return tickers;
}

async function fetchFinvizScreen(url: string, source: FinvizSource): Promise<FinvizTicker[]> {
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': UA },
    });
    if (!res.ok) {
      console.log(`    [Finviz ${source}] HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    return parseFinvizHtml(html).map(ticker => ({ ticker, company: '', source }));
  } catch (err) {
    console.log(`    [Finviz ${source}] failed:`, (err as Error).message);
    return [];
  }
}

const QUERIES: Record<FinvizSource, string> = {
  value_setup:       'https://finviz.com/screener.ashx?v=111&f=fa_pe_u15,fa_pb_u3,sh_avgvol_o500&ft=4&o=-marketcap',
  analyst_upgrade:   'https://finviz.com/screener.ashx?v=111&f=an_recom_buybetter,sh_avgvol_o500&ft=4&o=-marketcap',
  earnings_catalyst: 'https://finviz.com/screener.ashx?v=111&f=earningsdate_nextdays5,sh_avgvol_o500&ft=4&o=-marketcap',
  insider_buying:    'https://finviz.com/screener.ashx?v=111&f=ins_ownership_pos,sh_insidertrans_veryposlarge&ft=4&o=-marketcap',
  unusual_volume:    'https://finviz.com/screener.ashx?v=111&f=sh_relvol_o2,sh_avgvol_o500&ft=4&o=-relativevolume',
  oversold_bounce:   'https://finviz.com/screener.ashx?v=111&f=fa_curratio_o1,sh_avgvol_o500,ta_rsi_os30&ft=4&o=-marketcap',
};

/**
 * Fetch all 6 Finviz screens in parallel.
 * Returns flat list — same ticker may appear from multiple sources.
 */
export async function fetchAllFinvizSignals(): Promise<FinvizTicker[]> {
  const entries = Object.entries(QUERIES) as Array<[FinvizSource, string]>;
  const results = await Promise.all(entries.map(([source, url]) => fetchFinvizScreen(url, source)));
  const flat: FinvizTicker[] = [];
  for (const list of results) flat.push(...list);
  return flat;
}

export type { FinvizTicker, FinvizSource };
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors. (`pipeline.ts` imports `fetchAllFinvizSignals` which still exists — just with a different tuple structure. Pipeline rewrite in Phase D will handle that.)

- [ ] **Step 3: Quick smoke test of live queries**

```bash
cd backend && cat > /tmp/verify-finviz.ts <<'EOF'
import { fetchAllFinvizSignals } from './src/services/finviz.js';
(async () => {
  const results = await fetchAllFinvizSignals();
  const bySource = new Map<string, number>();
  for (const r of results) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
  console.log('Finviz results by source:');
  for (const [k, v] of bySource) console.log(`  ${k}: ${v}`);
  console.log('total tickers:', results.length);
  console.log('sample:', results.slice(0, 10));
  console.assert(results.length >= 20, 'should return at least 20 tickers across all 6 screens');
})();
EOF
npx tsx /tmp/verify-finviz.ts
rm /tmp/verify-finviz.ts
```

Expected: each source returns at least a few tickers (may be 0 for earnings_catalyst if no earnings next 5 days). Total ≥20. Sample looks like real US tickers.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/finviz.ts
git commit -m "feat: rewrite Finviz service with 6 unified universe queries"
```

---

## Task C2: Wire insider transactions into `enrichForClassifier`

**Files:**
- Modify: `backend/src/services/finnhub.ts`
- Modify: `backend/src/types/index.ts`

- [ ] **Step 1: Extend `ClassifierEnrichment` type**

Edit `backend/src/types/index.ts`, find the `ClassifierEnrichment` interface and add an `insiderActivity` field:

```typescript
export interface ClassifierEnrichment {
  analystRatings: {
    summary: string;
    meanTarget: number | null;
    highTarget: number | null;
    lowTarget: number | null;
  } | null;
  earnings: {
    nextDate: string | null;
    daysToEarnings: number | null;
    epsEstimate: number | null;
    earningsBeatRate: number | null;
  } | null;
  newsHeadlines: string[] | null;
  insiderActivity: {
    largeBuy90d: boolean;       // ≥1 buy >$100k in last 90d
    anyBuy90d: boolean;         // any positive buy in last 90d
    netSelling: boolean;        // more sells than buys by value
    largestBuyDate: string | null;  // YYYY-MM-DD
  } | null;
}
```

- [ ] **Step 2: Update `enrichForClassifier` to populate `insiderActivity`**

In `backend/src/services/finnhub.ts`, replace the `enrichForClassifier` function:

```typescript
export async function enrichForClassifier(
  ticker: string,
  existingHeadlines?: string[]
): Promise<ClassifierEnrichment> {
  const [recommendations, priceTarget, earnings, news, insider] = await Promise.all([
    fetchRecommendations(ticker).catch(() => null),
    fetchPriceTarget(ticker).catch(() => null),
    fetchEarningsCalendar(ticker).catch(() => [] as FinnhubEarnings[]),
    existingHeadlines && existingHeadlines.length > 0
      ? Promise.resolve(existingHeadlines)
      : fetchNews(ticker).then(articles => articles.slice(0, 5).map(a => a.headline)).catch(() => [] as string[]),
    fetchInsiderTransactions(ticker).catch(() => [] as FinnhubInsiderTransaction[]),
  ]);

  // Build analyst ratings summary
  let analystRatings: ClassifierEnrichment['analystRatings'] = null;
  if (recommendations || priceTarget) {
    const parts: string[] = [];
    if (recommendations) {
      if (recommendations.strongBuy) parts.push(`Strong Buy: ${recommendations.strongBuy}`);
      if (recommendations.buy) parts.push(`Buy: ${recommendations.buy}`);
      if (recommendations.hold) parts.push(`Hold: ${recommendations.hold}`);
      if (recommendations.sell) parts.push(`Sell: ${recommendations.sell}`);
      if (recommendations.strongSell) parts.push(`Strong Sell: ${recommendations.strongSell}`);
    }
    analystRatings = {
      summary: parts.length > 0 ? parts.join(', ') : 'No analyst coverage',
      meanTarget: priceTarget?.targetMean ?? null,
      highTarget: priceTarget?.targetHigh ?? null,
      lowTarget: priceTarget?.targetLow ?? null,
    };
  }

  // Build earnings info
  let earningsInfo: ClassifierEnrichment['earnings'] = null;
  const earningsArray = Array.isArray(earnings) ? earnings : [];
  if (earningsArray.length > 0) {
    const now = new Date();
    const upcoming = earningsArray.find(e => new Date(e.date) >= now);
    const historical = earningsArray
      .filter(e => e.epsActual !== null && e.epsEstimate !== null)
      .slice(0, 4);
    const beats = historical.filter(e => (e.epsActual ?? 0) > (e.epsEstimate ?? 0)).length;
    const beatRate = historical.length > 0 ? (beats / historical.length) * 100 : null;
    earningsInfo = {
      nextDate: upcoming?.date ?? null,
      daysToEarnings: upcoming ? Math.ceil((new Date(upcoming.date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : null,
      epsEstimate: upcoming?.epsEstimate ?? null,
      earningsBeatRate: beatRate !== null ? Math.round(beatRate) : null,
    };
  }

  // News headlines
  const newsArray = Array.isArray(news) ? news : [];
  const newsHeadlines = newsArray.length > 0 ? newsArray.slice(0, 5) : null;

  // Insider activity — last 90 days
  let insiderActivity: ClassifierEnrichment['insiderActivity'] = null;
  if (Array.isArray(insider) && insider.length > 0) {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const recent = insider.filter(t => {
      const d = new Date(t.transactionDate || t.filingDate);
      return !isNaN(d.getTime()) && d.getTime() >= cutoff;
    });
    // change > 0 = buy, change < 0 = sell
    const buys = recent.filter(t => (t.change || 0) > 0);
    const sells = recent.filter(t => (t.change || 0) < 0);
    const largeBuys = buys.filter(t => (t.change || 0) * (t.transactionPrice || 0) >= 100_000);
    const buyValue = buys.reduce((s, t) => s + (t.change || 0) * (t.transactionPrice || 0), 0);
    const sellValue = sells.reduce((s, t) => s - (t.change || 0) * (t.transactionPrice || 0), 0);
    const largestBuy = largeBuys.sort((a, b) =>
      (b.change * b.transactionPrice) - (a.change * a.transactionPrice)
    )[0];
    insiderActivity = {
      largeBuy90d: largeBuys.length > 0,
      anyBuy90d: buys.length > 0,
      netSelling: sellValue > buyValue,
      largestBuyDate: largestBuy?.transactionDate ?? largestBuy?.filingDate ?? null,
    };
  }

  return { analystRatings, earnings: earningsInfo, newsHeadlines, insiderActivity };
}
```

- [ ] **Step 2a: Remove unused `_ticker` param warnings if any arose**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/types/index.ts backend/src/services/finnhub.ts
git commit -m "feat: wire insider activity into classifier enrichment"
```

---

# PHASE D — CLASSIFIER REWRITE

## Task D1: Rewrite Perplexity classifier

**Files:**
- Modify: `backend/src/services/classifier.ts` (near-total rewrite)

**Note:** Keep the existing `generateAnalysis` export name to minimize churn at the call site, but change its return type to `UnifiedClassification`. The pipeline's call site will be updated in Phase E.

- [ ] **Step 1: Replace classifier.ts**

Replace the entire contents of `backend/src/services/classifier.ts` with:

```typescript
// backend/src/services/classifier.ts
import { config } from '../lib/config.js';
import { fetchWithRetry } from '../lib/http.js';
import type {
  MergedSentiment,
  PriceData,
  FundamentalData,
  TechnicalIndicators,
  ClassifierEnrichment,
  ComponentScores,
  UnifiedClassification,
} from '../types/index.js';

const PPLX_URL = 'https://api.perplexity.ai/chat/completions';

export interface ClassifierContext {
  sentiment: MergedSentiment;
  price: PriceData;
  fundamentals: FundamentalData;
  technicals: TechnicalIndicators | null;
  enrichment: ClassifierEnrichment | undefined;
  scores: ComponentScores;
  tradeable: boolean;
  gateFailures: string[];
}

const FALLBACK: UnifiedClassification = {
  thesis: 'Unable to generate thesis — classifier failed.',
  valueCase: '',
  catalysts: [],
  keyRisks: ['classifier_unavailable'],
  expectedReturn30d: 0,
  convictionScore: 0,
  recommendation: 'AVOID',
};

export async function generateAnalysis(context: ClassifierContext): Promise<UnifiedClassification> {
  if (!config.perplexityApiKey) {
    console.warn('[classifier] PERPLEXITY_API_KEY not set — returning fallback');
    return FALLBACK;
  }

  const prompt = buildPrompt(context);

  try {
    const response = await fetchWithRetry<{
      choices: Array<{ message: { content: string } }>;
    }>(
      PPLX_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.perplexityApiKey}`,
        },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [
            { role: 'system', content: 'You are a disciplined equity analyst. Respond with VALID JSON only, no prose. Verify any claim about dates or numbers against the web context you retrieve.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 900,
        }),
      }
    );

    const content = response?.choices?.[0]?.message?.content ?? '';
    const parsed = parseResponse(content);
    return parsed ?? FALLBACK;
  } catch (err) {
    console.warn(`[classifier] ${context.fundamentals.ticker} failed:`, err instanceof Error ? err.message : err);
    return FALLBACK;
  }
}

function buildPrompt(ctx: ClassifierContext): string {
  const { fundamentals: f, price: p, scores, enrichment } = ctx;
  const analyst = enrichment?.analystRatings;
  const earnings = enrichment?.earnings;
  const insider = enrichment?.insiderActivity;
  const headlines = enrichment?.newsHeadlines ?? [];

  return `Evaluate ${f.ticker} (${f.name}) as a VALUE + CATALYST opportunity over the next 30 days.

Market data:
- Sector: ${f.sector}, Industry: ${f.industry}
- Price: $${p.price.toFixed(2)}, 52w range: $${p.low52w.toFixed(2)}-$${p.high52w.toFixed(2)}
- Market cap: $${(f.marketCap / 1e9).toFixed(1)}B
- P/E: ${f.peRatio ?? 'n/a'}, P/B: ${f.pbRatio ?? 'n/a'}, P/S: ${f.psRatio ?? 'n/a'}
- Revenue growth TTM: ${f.revenueGrowth !== null ? (f.revenueGrowth * 100).toFixed(1) + '%' : 'n/a'}
- Gross margin: ${f.grossMargin !== null ? (f.grossMargin * 100).toFixed(1) + '%' : 'n/a'}
- Operating margin: ${f.operatingMargin !== null ? (f.operatingMargin * 100).toFixed(1) + '%' : 'n/a'}
- Debt/Equity: ${f.debtEquity ?? 'n/a'}

Pre-computed component scores (out of 100, higher = better except risk):
- Value: ${scores.value}
- Catalyst: ${scores.catalyst}
- Upside: ${scores.upside}
- Risk: ${scores.risk}
- Composite: ${scores.composite}
- Tradeable: ${ctx.tradeable ? 'yes' : 'no' + (ctx.gateFailures.length ? ' (' + ctx.gateFailures.join(',') + ')' : '')}

Enrichment:
- Analyst: ${analyst ? `${analyst.summary}, mean target ${analyst.meanTarget ?? 'n/a'}` : 'none'}
- Earnings: ${earnings ? `next ${earnings.nextDate ?? 'n/a'} (${earnings.daysToEarnings ?? '?'}d), beat rate ${earnings.earningsBeatRate ?? '?'}%` : 'none'}
- Insider last 90d: ${insider ? `largeBuy=${insider.largeBuy90d}, anyBuy=${insider.anyBuy90d}, netSelling=${insider.netSelling}` : 'none'}
- Recent headlines: ${headlines.length > 0 ? headlines.join(' | ') : 'none'}

Respond with ONLY this JSON shape (no markdown, no prose):
{
  "thesis": "2-3 sentences explaining the setup in plain English",
  "valueCase": "Why is this mispriced? Against what comparable?",
  "catalysts": [
    {"description": "Specific upcoming event", "date": "YYYY-MM-DD or null"}
  ],
  "keyRisks": ["risk 1", "risk 2"],
  "expectedReturn30d": 0,
  "convictionScore": 0,
  "recommendation": "BUY | WATCH | AVOID"
}

Rules:
- expectedReturn30d: integer percent (e.g. 15 for +15%). Base your estimate on catalyst proximity and upside to analyst mean target.
- convictionScore: 0-10. 8-10 = rare high-conviction opportunity. 5-7 = decent. 0-4 = skip.
- recommendation: BUY only if composite ≥ 65, risk ≤ 45, tradeable = yes.
- Catalysts must be SPECIFIC (earnings on X date, PDUFA on Y date, product launch Z). Do not list generic "market momentum".
- If no real catalyst, set recommendation = WATCH or AVOID, and catalysts = [].`;
}

function parseResponse(text: string): UnifiedClassification | null {
  // Extract JSON even if wrapped in markdown code fences
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0) return null;
  const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(jsonStr);
    // Validate shape
    if (typeof parsed.thesis !== 'string') return null;
    if (!Array.isArray(parsed.catalysts)) parsed.catalysts = [];
    if (!Array.isArray(parsed.keyRisks)) parsed.keyRisks = [];
    if (typeof parsed.expectedReturn30d !== 'number') parsed.expectedReturn30d = 0;
    if (typeof parsed.convictionScore !== 'number') parsed.convictionScore = 0;
    if (!['BUY', 'WATCH', 'AVOID'].includes(parsed.recommendation)) parsed.recommendation = 'WATCH';
    if (typeof parsed.valueCase !== 'string') parsed.valueCase = '';
    return parsed as UnifiedClassification;
  } catch {
    return null;
  }
}

export default { generateAnalysis };
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: pipeline.ts will error because it still uses old `DualTierClassificationResult` fields. That's expected — we fix it in Phase E. Confirm the errors are ONLY in pipeline.ts, not in classifier.ts itself.

- [ ] **Step 3: Commit (with failing tsc — fixed in next task)**

```bash
git add backend/src/services/classifier.ts
git commit -m "feat: rewrite classifier prompt + response for unified screener"
```

---

# PHASE E — PIPELINE REFACTOR

## Task E1: Category classification helper

**Files:**
- Create: `backend/src/services/categoryClassification.ts`

- [ ] **Step 1: Write the module**

```typescript
// backend/src/services/categoryClassification.ts
import type {
  ComponentScores,
  ClassifierEnrichment,
  EntryCategory,
} from '../types/index.js';

export const CATEGORY_MAX_HOLD_DAYS: Record<EntryCategory, number> = {
  earnings_event:     12,
  insider_signal:     30,
  value_rerating:     45,
  attention_momentum: 7,
};

export const DEFAULT_MAX_HOLD_DAYS = 35;

export interface CategoryDetermination {
  category: EntryCategory;
  catalystType: string;
  catalystDate: string | null; // YYYY-MM-DD
}

/**
 * Determines entry category at BUY time. Priority order:
 * 1. earnings_event  — earnings within 10 days
 * 2. insider_signal  — large insider buy in last 30 days
 * 3. value_rerating  — value score ≥ 70
 * 4. attention_momentum — default
 *
 * Short-circuits at first match.
 */
export function determineEntryCategory(
  scores: ComponentScores,
  enrichment: ClassifierEnrichment | undefined
): CategoryDetermination {
  // 1. Earnings event
  const dte = enrichment?.earnings?.daysToEarnings;
  const earningsDate = enrichment?.earnings?.nextDate ?? null;
  if (typeof dte === 'number' && dte >= 0 && dte <= 10 && earningsDate) {
    return {
      category: 'earnings_event',
      catalystType: `earnings_${earningsDate}`,
      catalystDate: earningsDate,
    };
  }

  // 2. Insider signal (large buy in last 30 days)
  const insider = enrichment?.insiderActivity;
  if (insider?.largeBuy90d && insider.largestBuyDate) {
    const dt = new Date(insider.largestBuyDate);
    const daysAgo = (Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysAgo <= 30) {
      return {
        category: 'insider_signal',
        catalystType: `insider_buy_${insider.largestBuyDate}`,
        catalystDate: insider.largestBuyDate,
      };
    }
  }

  // 3. Value rerating
  if (scores.value >= 70) {
    return {
      category: 'value_rerating',
      catalystType: 'value_rerating',
      catalystDate: null,
    };
  }

  // 4. Default
  return {
    category: 'attention_momentum',
    catalystType: 'attention_momentum',
    catalystDate: null,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: still errors in pipeline.ts (from D1), but categoryClassification.ts itself is clean.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/categoryClassification.ts
git commit -m "feat: add entry category determination + category hold-day constants"
```

---

## Task E2: Refactor `pipeline.ts` — selection + filtering + enrichment

**Files:**
- Modify: `backend/src/pipeline.ts`

This is the biggest rewrite in the plan. The goal is to replace the dual-tier code paths (lines dealing with `selectTickersWithDualTier`, `enrichTickersWithMarketDataTiered`, `validateQualityTickers`, `applyUniverseFiltersTiered`, `calculateTechnicalsForTickersTiered`) with single-path equivalents.

- [ ] **Step 1: Read the current pipeline.ts fully**

Run: `cat backend/src/pipeline.ts | wc -l`
Then read in chunks: `sed -n '1,250p'`, `sed -n '250,500p'`, etc. Understand the full flow before editing.

- [ ] **Step 2: Rewrite `fetchAllSentimentData` to merge Finviz sub-source hits**

In the existing `fetchAllSentimentData` function, the Finviz loop currently pushes all Finviz results as `source: 'finviz'`. After the C1 rewrite, each `FinvizTicker` has a `source` field like `'value_setup'` or `'earnings_catalyst'`. We want to count how many distinct sub-screens each ticker hit.

Replace the Finviz block (around current line 195-207) with:

```typescript
  // Finviz — 6 unified universe queries (was: 4 penny screens)
  console.log('  - Fetching from Finviz (6 unified screens)...');
  const finvizData = await fetchAllFinvizSignals();
  // Count distinct sub-screen hits per ticker to use as a signal for upside scoring
  const finvizHitCount = new Map<string, number>();
  const finvizTickers = new Set<string>();
  for (const item of finvizData) {
    const key = `${item.ticker}:${item.source}`;
    if (finvizTickers.has(key)) continue;
    finvizTickers.add(key);
    finvizHitCount.set(item.ticker, (finvizHitCount.get(item.ticker) ?? 0) + 1);
  }
  // Push one sentiment row per ticker (not per sub-screen) to avoid source double-counting
  const seenFinvizTickers = new Set<string>();
  for (const item of finvizData) {
    if (seenFinvizTickers.has(item.ticker)) continue;
    seenFinvizTickers.add(item.ticker);
    results.push({
      ticker: item.ticker,
      source: 'finviz',
      mentions: finvizHitCount.get(item.ticker) ?? 1, // use hit count as mention proxy
      sentiment: 75,
      rank: 0,
    });
  }
  console.log(`    Found ${finvizHitCount.size} unique Finviz tickers across ${finvizData.length} hits`);
```

Also store the `finvizHitCount` map at module scope so the scoring step can access it. At the top of pipeline.ts (after imports), add:

```typescript
// Per-run state populated during source fetch, consumed during scoring
const finvizHitsByTicker = new Map<string, number>();
```

Update the Finviz block to `finvizHitsByTicker.set(item.ticker, ...)` instead of a local map. (Remove the local `finvizHitCount` and use the module-level map.)

- [ ] **Step 3: Replace `selectTickersWithDualTier` with single-path selection**

Delete the entire `selectTickersWithDualTier` function and the `TieredTicker` interface. Replace with:

```typescript
/**
 * Single-path candidate selection.
 * Ranks merged tickers by a lightweight pre-score (no API calls) and returns top N.
 * Pre-score prioritizes: Finviz screen hits, then apewisdom-penny mentions, then totalMentions.
 */
function selectTopCandidates(
  merged: Record<string, MergedSentiment>,
  maxTickers: number
): string[] {
  const entries = Object.entries(merged);
  entries.sort((a, b) => {
    const aFv = finvizHitsByTicker.get(a[0]) ?? 0;
    const bFv = finvizHitsByTicker.get(b[0]) ?? 0;
    if (bFv !== aFv) return bFv - aFv;
    const aPenny = a[1].sources['apewisdom-penny']?.mentions ?? 0;
    const bPenny = b[1].sources['apewisdom-penny']?.mentions ?? 0;
    if (bPenny !== aPenny) return bPenny - aPenny;
    return b[1].totalMentions - a[1].totalMentions;
  });
  return entries.slice(0, maxTickers).map(e => e[0]);
}
```

Update the call site (current line ~56) that calls `selectTickersWithDualTier`:

```typescript
    const MAX_TICKERS = process.env.MAX_TICKERS ? parseInt(process.env.MAX_TICKERS) : 30;
    const tickerSymbols = selectTopCandidates(mergedSentiment, MAX_TICKERS);
    console.log(`Unique tickers to analyze: ${tickerSymbols.length} (selected from ${Object.keys(mergedSentiment).length})`);
```

- [ ] **Step 4: Replace `enrichTickersWithMarketDataTiered` with single-path enrichment**

Delete the old function. Replace with:

```typescript
import { fetchQuoteSummary } from './services/yahoo.js';

interface EnrichedTicker {
  ticker: string;
  sentiment: MergedSentiment;
  price: PriceData;
  fundamentals: FundamentalData;
  yahoo: YahooQuoteSummary | null;
}

async function enrichTickers(
  tickerSymbols: string[],
  merged: Record<string, MergedSentiment>
): Promise<EnrichedTicker[]> {
  const enriched: EnrichedTicker[] = [];
  let done = 0;
  for (const ticker of tickerSymbols) {
    try {
      const [price, fundamentals, yahoo] = await Promise.all([
        finnhub.fetchPriceData(ticker),
        finnhub.fetchFundamentalData(ticker),
        fetchQuoteSummary(ticker),
      ]);
      done++;
      if (done % 10 === 0 || done === tickerSymbols.length) {
        console.log(`  Progress: ${done}/${tickerSymbols.length} tickers`);
      }
      if (!price || !fundamentals) continue;
      enriched.push({
        ticker,
        sentiment: merged[ticker],
        price,
        fundamentals,
        yahoo,
      });
    } catch (err) {
      console.warn(`  Enrichment failed for ${ticker}:`, (err as Error).message);
    }
    await sleep(150); // polite to APIs
  }
  return enriched;
}
```

Add `YahooQuoteSummary` to the type imports at the top. Add `import { fetchQuoteSummary } from './services/yahoo.js';` to the imports. Remove the `validateQualityTickers` call and function — it's no longer applicable.

Update the call site (around current line 60):

```typescript
    console.log('\n[3/8] Fetching price and fundamental data...');
    const enrichedTickers = await enrichTickers(tickerSymbols, mergedSentiment);
    console.log(`Successfully enriched ${enrichedTickers.length} tickers`);
```

Delete the "Step 4.5: Validate QUALITY tier assignments" block entirely.

- [ ] **Step 5: Replace `applyUniverseFiltersTiered` with `applyUniverseFilters`**

Replace the function. New version drops price gates entirely, keeps only US-only and liquidity floor:

```typescript
function applyUniverseFilters(enriched: EnrichedTicker[]): EnrichedTicker[] {
  const filtered: EnrichedTicker[] = [];
  for (const t of enriched) {
    // Liquidity floor — meaningful average volume
    if (!t.price.avgVolume30d || t.price.avgVolume30d < 500_000) {
      console.log(`  Filtered ${t.ticker}: avg volume ${t.price.avgVolume30d} < 500k`);
      continue;
    }
    // US-only
    const country = (t.fundamentals.country || '').toUpperCase();
    if (country && country !== 'US') {
      console.log(`  Filtered ${t.ticker}: country ${country} not US`);
      continue;
    }
    filtered.push(t);
  }
  return filtered;
}
```

Update the call site:

```typescript
    console.log('\n[4/8] Applying universe filters...');
    const filteredTickers = applyUniverseFilters(enrichedTickers);
    console.log(`Tickers after filtering: ${filteredTickers.length}`);
```

- [ ] **Step 6: Replace `calculateTechnicalsForTickersTiered` with single-path**

```typescript
interface TickerWithTech extends EnrichedTicker {
  technicals: TechnicalIndicators | null;
}

async function calculateTechnicalsForTickers(
  tickers: EnrichedTicker[]
): Promise<TickerWithTech[]> {
  const out: TickerWithTech[] = [];
  for (const t of tickers) {
    let tech: TechnicalIndicators | null = null;
    try {
      tech = await technicals.calculateTechnicalIndicators(t.ticker, t.price);
    } catch (err) {
      console.warn(`  Technicals failed for ${t.ticker}:`, (err as Error).message);
    }
    out.push({ ...t, technicals: tech });
  }
  return out;
}
```

Update the call site:

```typescript
    console.log('\n[5/8] Calculating technical indicators...');
    const tickersWithTechnicals = await calculateTechnicalsForTickers(filteredTickers);
    console.log(`Technical indicators calculated for ${tickersWithTechnicals.filter(t => t.technicals !== null).length} tickers`);
```

- [ ] **Step 7: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: errors remain in the save site and the scoring/classify call site. That's expected — next task handles those.

- [ ] **Step 8: Commit**

```bash
git add backend/src/pipeline.ts
git commit -m "refactor: collapse dual-tier pipeline functions into single path"
```

---

## Task E3: Replace `scoreAndClassify` and save site in pipeline.ts

**Files:**
- Modify: `backend/src/pipeline.ts`

- [ ] **Step 1: Replace `fetchClassifierEnrichment` + `scoreAndClassify` + `saveResults`**

Find the old functions and replace them with the unified versions below.

Replace `fetchClassifierEnrichment` — it still works as-is except the type now includes `insiderActivity`. Keep the existing function.

Delete the old `scoreAndClassify` and replace with:

```typescript
import {
  calculateAllUnifiedScores,
  classifyUnified,
} from './services/scoring.js';
import { evaluateTradeability } from './lib/tradeability.js';
import { determineEntryCategory } from './services/categoryClassification.js';
import type { ComponentScores, TradeabilityResult, UnifiedClassification } from './types/index.js';

interface FinalizedTicker extends TickerWithTech {
  enrichment: ClassifierEnrichment | undefined;
  scores: ComponentScores;
  tradeability: TradeabilityResult;
  classification: UnifiedClassification;
  entryCategory: ReturnType<typeof determineEntryCategory>;
}

async function scoreAndClassify(
  tickers: TickerWithTech[]
): Promise<FinalizedTicker[]> {
  // First: fetch classifier enrichment (reuses existing function)
  const withEnrichment = await fetchClassifierEnrichment(tickers);

  const output: FinalizedTicker[] = [];
  for (const t of withEnrichment) {
    // Evaluate tradeability (hard gates)
    const tradeability = evaluateTradeability({
      price: t.price,
      fundamentals: t.fundamentals,
      yahoo: t.yahoo,
      enrichment: t.enrichment,
    });

    // Compute component scores
    const insider = t.enrichment?.insiderActivity;
    const scores = calculateAllUnifiedScores({
      sentiment: t.sentiment,
      price: t.price,
      fundamentals: t.fundamentals,
      yahoo: t.yahoo,
      enrichment: t.enrichment,
      technicals: t.technicals,
      finvizHits: finvizHitsByTicker.get(t.ticker) ?? 0,
      insiderLargeBuy90d: insider?.largeBuy90d ?? false,
      insiderAnyBuy90d: insider?.anyBuy90d ?? false,
      insiderNetSelling: insider?.netSelling ?? false,
    });

    // Determine entry category (even for non-BUY rows; used if later classified BUY)
    const entryCategory = determineEntryCategory(scores, t.enrichment);

    // Run classifier (Perplexity) for narrative
    let classification: UnifiedClassification;
    try {
      classification = await classifier.generateAnalysis({
        sentiment: t.sentiment,
        price: t.price,
        fundamentals: t.fundamentals,
        technicals: t.technicals,
        enrichment: t.enrichment,
        scores,
        tradeable: tradeability.tradeable,
        gateFailures: tradeability.failures,
      });
    } catch (err) {
      console.warn(`  Classifier failed for ${t.ticker}:`, (err as Error).message);
      classification = {
        thesis: 'Classifier error',
        valueCase: '',
        catalysts: [],
        keyRisks: ['classifier_error'],
        expectedReturn30d: 0,
        convictionScore: 0,
        recommendation: 'AVOID',
      };
    }

    // Final classification may override the LLM if our numeric thresholds disagree
    const numericLabel = classifyUnified(scores, tradeability.tradeable);
    // Use numeric as the source of truth for the recommendation field
    classification.recommendation = numericLabel;

    output.push({
      ...t,
      scores,
      tradeability,
      classification,
      entryCategory,
    });
  }
  return output;
}
```

Add the import for `classifier`:

```typescript
import classifier from './services/classifier.js';
```

(Verify this is already imported at the top — if not, add it.)

- [ ] **Step 2: Replace `saveResults` to write new columns**

Replace `saveResults` with:

```typescript
async function saveResults(finalized: FinalizedTicker[]): Promise<void> {
  for (const t of finalized) {
    await db.query(
      `INSERT INTO scan_results (
        run_id, run_timestamp, ticker,
        swaggy_mentions, swaggy_sentiment, swaggy_momentum,
        apewisdom_rank, apewisdom_mentions, altindex_score,
        total_mentions, avg_sentiment, source_count,
        price, price_change_1d, price_change_1d_pct,
        price_change_5d, price_change_5d_pct,
        price_change_30d, price_change_30d_pct,
        volume, avg_volume_30d, relative_volume,
        high_52w, low_52w,
        company_name, market_cap, pe_ratio, ps_ratio, pb_ratio,
        revenue_growth, gross_margin, operating_margin, debt_equity,
        exchange, sector, industry, country,
        attention_score, momentum_score, fundamentals_score, risk_score,
        classification, confidence, bull_case, bear_case, catalysts,
        alert_triggered, alert_type,
        rsi_14, macd_value, macd_signal, macd_histogram,
        bb_upper, bb_middle, bb_lower,
        sma_20, sma_50, sma_200, ema_20,
        technical_signal, technical_strength,
        tier, value_score, catalyst_score, emerging_industry_score,
        thesis, edge_why_now, industry_theme, stop_loss_pct, expected_returns,
        analyst_mean_target, analyst_summary, earnings_date, days_to_earnings,
        earnings_beat_rate, news_headlines,
        tradeable, gate_failures
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15,
        $16, $17,
        $18, $19,
        $20, $21, $22,
        $23, $24,
        $25, $26, $27, $28, $29,
        $30, $31, $32, $33,
        $34, $35, $36, $37,
        $38, $39, $40, $41,
        $42, $43, $44, $45, $46,
        $47, $48,
        $49, $50, $51, $52,
        $53, $54, $55,
        $56, $57, $58, $59,
        $60, $61,
        $62, $63, $64, $65,
        $66, $67, $68, $69, $70,
        $71, $72, $73, $74,
        $75, $76,
        $77, $78
      )`,
      [
        t.sentiment ? RUN_ID : RUN_ID,
        new Date(),
        t.ticker,
        t.sentiment.sources.swaggy?.mentions ?? null,
        t.sentiment.sources.swaggy?.sentiment ?? null,
        t.sentiment.sources.swaggy?.momentum ?? null,
        t.sentiment.sources['apewisdom-penny']?.rank
          ?? t.sentiment.sources['apewisdom-all']?.rank
          ?? t.sentiment.sources['apewisdom-wsb']?.rank ?? null,
        t.sentiment.sources['apewisdom-penny']?.mentions
          ?? t.sentiment.sources['apewisdom-all']?.mentions
          ?? t.sentiment.sources['apewisdom-wsb']?.mentions ?? null,
        t.sentiment.sources.altindex?.sentiment ?? null,
        t.sentiment.totalMentions,
        t.sentiment.avgSentiment,
        t.sentiment.sourceCount,
        t.price.price,
        t.price.change1d, t.price.change1dPercent,
        t.price.change5d, t.price.change5dPercent,
        t.price.change30d, t.price.change30dPercent,
        t.price.volume ? Math.round(t.price.volume) : null,
        t.price.avgVolume30d ? Math.round(t.price.avgVolume30d) : null,
        t.price.relativeVolume,
        t.price.high52w, t.price.low52w,
        t.fundamentals.name,
        t.fundamentals.marketCap ? Math.round(t.fundamentals.marketCap) : null,
        t.fundamentals.peRatio,
        t.fundamentals.psRatio,
        t.fundamentals.pbRatio,
        t.fundamentals.revenueGrowth,
        t.fundamentals.grossMargin,
        t.fundamentals.operatingMargin,
        t.fundamentals.debtEquity,
        t.fundamentals.exchange,
        t.fundamentals.sector,
        t.fundamentals.industry,
        t.fundamentals.country,
        // Legacy score columns → repurposed for unified component scores
        t.scores.attention,   // attention_score
        t.scores.upside,      // momentum_score (repurposed as upside proxy)
        t.scores.value,       // fundamentals_score (repurposed as value proxy)
        t.scores.risk,        // risk_score
        t.classification.recommendation,     // classification
        t.classification.convictionScore / 10,  // confidence (0-1)
        t.classification.valueCase,           // bull_case (repurposed)
        (t.classification.keyRisks ?? []).join('; '),  // bear_case (repurposed)
        (t.classification.catalysts ?? []).map(c => c.description).join('; '),  // catalysts
        false,  // alert_triggered
        null,   // alert_type
        t.technicals?.rsi14 ?? null,
        t.technicals?.macd ?? null,
        t.technicals?.macdSignal ?? null,
        t.technicals?.macdHistogram ?? null,
        t.technicals?.bbUpper ?? null,
        t.technicals?.bbMiddle ?? null,
        t.technicals?.bbLower ?? null,
        t.technicals?.sma20 ?? null,
        t.technicals?.sma50 ?? null,
        t.technicals?.sma200 ?? null,
        t.technicals?.ema20 ?? null,
        t.technicals?.technicalSignal ?? null,
        t.technicals?.signalStrength ?? null,
        // Tier column kept for schema compat, new rows tagged UNIFIED
        'UNIFIED',
        t.scores.value,       // value_score (now from unified scoring)
        t.scores.catalyst,    // catalyst_score
        t.scores.upside,      // emerging_industry_score (repurposed as upside)
        t.classification.thesis,
        t.classification.valueCase ? t.classification.valueCase.slice(0, 500) : null,  // edge_why_now
        null,  // industry_theme — removed
        null,  // stop_loss_pct — removed
        JSON.stringify({ thirty_day_pct: t.classification.expectedReturn30d }),  // expected_returns
        t.yahoo?.targetMeanPrice ?? null,
        t.enrichment?.analystRatings?.summary ?? null,
        t.enrichment?.earnings?.nextDate ?? null,
        t.enrichment?.earnings?.daysToEarnings ?? null,
        t.enrichment?.earnings?.earningsBeatRate ?? null,
        t.enrichment?.newsHeadlines ?? null,
        t.tradeability.tradeable,
        t.tradeability.failures,
      ]
    );
  }
  console.log(`  Saved ${finalized.length} results to database`);
}
```

- [ ] **Step 3: Update the pipeline main flow to pass correct types**

Around line 84-92, replace:

```typescript
    console.log('\n[6/8] Scoring and classifying tickers...');
    const finalized = await scoreAndClassify(tickersWithTechnicals);

    console.log('\n[7/8] Saving results to database...');
    await saveResults(finalized);
```

Delete the old `[6.5/9]` fetchClassifierEnrichment step from the main flow (it's now called inside `scoreAndClassify`).

- [ ] **Step 4: Update `printSummary` to use new shape**

Find `printSummary` (probably near the bottom). Replace its body to iterate over `FinalizedTicker`:

```typescript
function printSummary(finalized: FinalizedTicker[]): void {
  console.log('\n============================================================');
  console.log('PIPELINE SUMMARY');
  console.log('============================================================');
  const buys = finalized.filter(t => t.classification.recommendation === 'BUY');
  const watches = finalized.filter(t => t.classification.recommendation === 'WATCH');
  const avoids = finalized.filter(t => t.classification.recommendation === 'AVOID');
  const tradeable = finalized.filter(t => t.tradeability.tradeable).length;
  console.log(`Total tickers analyzed: ${finalized.length}`);
  console.log(`  BUY:    ${buys.length}`);
  console.log(`  WATCH:  ${watches.length}`);
  console.log(`  AVOID:  ${avoids.length}`);
  console.log(`  Tradeable: ${tradeable}/${finalized.length}`);
  console.log('\nTop BUY candidates (by composite):');
  buys.sort((a, b) => b.scores.composite - a.scores.composite).slice(0, 10).forEach(t => {
    console.log(`  ${t.ticker.padEnd(6)} comp=${t.scores.composite} V=${t.scores.value} C=${t.scores.catalyst} U=${t.scores.upside} R=${t.scores.risk} [${t.entryCategory.category}]`);
  });
  console.log('============================================================');
}
```

Call site update: `printSummary(finalized);` (already matches).

- [ ] **Step 5: Delete the old update helper calls**

If `updateRunRecord` takes `momentumCount`/`qualityCount`, pass 0 for both (or unify). Find its call around line 133:

```typescript
    const alertCount = 0; // alerts system not wired to new classification yet
    await updateRunRecord('completed', finalized.length, alertCount, undefined, 0, 0);
```

- [ ] **Step 6: Update trader invocation to use new shape**

Around line 107-113, the trader currently gets `analyzedTickers`. Update it:

```typescript
        // 8b. Evaluate and execute
        const account = await alpacaService.getAccount();
        const positions = await alpacaService.getPositions();
        const decisions = await trader.evaluate(finalized, positions, account, tradingConfig);
        const executed = await trader.execute(decisions);
        await trader.logDecisions(executed, RUN_ID);
        await trader.updatePortfolioState(RUN_ID, finalized);
```

(Trader refactor happens in Phase F — expect typecheck errors from this step until then.)

- [ ] **Step 7: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: errors in trader.ts (still uses old `PipelineResult` type) and maybe a few in pipeline.ts around the trader call. Confirm pipeline.ts itself is otherwise clean except for those trader-boundary errors.

- [ ] **Step 8: Commit (with failing tsc — trader refactor next)**

```bash
git add backend/src/pipeline.ts
git commit -m "refactor: single-path scoring, classification, and save in pipeline"
```

---

# PHASE F — TRADER REFACTOR

## Task F1: Trader — new pipeline result type + uniform sizing

**Files:**
- Modify: `backend/src/services/trader.ts`

- [ ] **Step 1: Update `PipelineResult` type and remove tier-based sizing**

Replace the `PipelineResult` type alias near the top (around line 24) with:

```typescript
import type {
  TradingConfig,
  TradeDecision,
  AlpacaAccount,
  AlpacaPosition,
  AlpacaOrder,
  ComponentScores,
  EntryCategory,
  UnifiedClassification,
  ClassifierEnrichment,
  PriceData,
  FundamentalData,
  YahooQuoteSummary,
  TradeabilityResult,
  MergedSentiment,
} from '../types/index.js';
import type { TechnicalIndicators } from './technicals.js';
import { CATEGORY_MAX_HOLD_DAYS, DEFAULT_MAX_HOLD_DAYS } from './categoryClassification.js';

// PipelineResult is now the FinalizedTicker from pipeline.ts, duplicated here
// to avoid a circular import. Keep the shapes in sync.
export interface PipelineResult {
  ticker: string;
  sentiment: MergedSentiment;
  price: PriceData;
  fundamentals: FundamentalData;
  yahoo: YahooQuoteSummary | null;
  technicals: TechnicalIndicators | null;
  enrichment: ClassifierEnrichment | undefined;
  scores: ComponentScores;
  tradeability: TradeabilityResult;
  classification: UnifiedClassification;
  entryCategory: {
    category: EntryCategory;
    catalystType: string;
    catalystDate: string | null;
  };
}
```

- [ ] **Step 2: Rewrite `evaluateBuy` for uniform sizing + attribution**

Replace `evaluateBuy` with:

```typescript
async function evaluateBuy(
  result: PipelineResult,
  positions: AlpacaPosition[],
  account: AlpacaAccount,
  config: TradingConfig
): Promise<TradeDecision> {
  const ticker = result.ticker;
  const rec = result.classification.recommendation;
  const scores = result.scores;
  // Map unified scores onto the TradeDecision.scores shape expected by existing code.
  // Use (attention, upside, value, risk) → (attention, momentum, fundamentals, risk)
  const legacyScores = {
    attention: scores.attention,
    momentum: scores.upside,
    fundamentals: scores.value,
    risk: scores.risk,
  };

  if (rec !== 'BUY') {
    return {
      ticker, action: 'SKIP',
      reason: `Recommendation ${rec} not actionable`,
      classification: rec.toLowerCase() as any,
      scores: legacyScores,
    };
  }

  // Hard tradeability gate
  if (!result.tradeability.tradeable) {
    return {
      ticker, action: 'SKIP',
      reason: `Not tradeable: ${result.tradeability.failures.join(', ')}`,
      classification: rec.toLowerCase() as any,
      scores: legacyScores,
    };
  }

  // Threshold gates from config (retuned for value/catalyst)
  if (scores.value < config.minFundamentals) {
    return { ticker, action: 'SKIP', reason: `Value ${scores.value} < min ${config.minFundamentals}`, classification: rec.toLowerCase() as any, scores: legacyScores };
  }
  if (scores.risk > config.maxRisk) {
    return { ticker, action: 'SKIP', reason: `Risk ${scores.risk} > max ${config.maxRisk}`, classification: rec.toLowerCase() as any, scores: legacyScores };
  }
  if (scores.upside < config.minMomentum) {
    return { ticker, action: 'SKIP', reason: `Upside ${scores.upside} < min ${config.minMomentum}`, classification: rec.toLowerCase() as any, scores: legacyScores };
  }

  // High conviction: composite ≥ 80, risk ≤ 30, ≥5 analyst opinions
  const analystCount = result.yahoo?.numberOfAnalystOpinions ?? 0;
  const isHighConviction = scores.composite >= 80 && scores.risk <= 30 && analystCount >= 5;

  // Uniform sizing
  const sizePct = isHighConviction ? config.highConvictionSizePct : 10; // 10% base, 14% high-conv
  const rawOrderValue = account.portfolioValue * (sizePct / 100);
  const orderValue = rawOrderValue * (1 - config.slippagePct / 100);
  const price = result.price.price;
  const quantity = Math.floor(orderValue / price);

  if (quantity <= 0) {
    return { ticker, action: 'SKIP', reason: `Position too small ($${price} × 0)`, classification: rec.toLowerCase() as any, scores: legacyScores };
  }

  // Risk validation
  const actualOrderValue = quantity * price;
  const riskCheck = validateBuy(ticker, actualOrderValue, account, positions, config);
  if (!riskCheck.approved) {
    return { ticker, action: 'SKIP', reason: `Risk check: ${riskCheck.reason}`, classification: rec.toLowerCase() as any, scores: legacyScores };
  }

  const finalQuantity = riskCheck.adjustedQuantity ?? quantity;

  // Build entry attribution (logged at BUY time)
  const entryAttribution = {
    valueScore: scores.value,
    catalystScore: scores.catalyst,
    upsideScore: scores.upside,
    riskScore: scores.risk,
    composite: scores.composite,
    category: result.entryCategory.category,
    catalystType: result.entryCategory.catalystType,
    catalystDate: result.entryCategory.catalystDate,
  };

  return {
    ticker,
    action: 'BUY',
    reason: `BUY (${isHighConviction ? 'high-conv' : 'standard'}, ${result.entryCategory.category}) comp=${scores.composite} V=${scores.value} C=${scores.catalyst} U=${scores.upside} R=${scores.risk}`,
    quantity: finalQuantity,
    positionSizePct: sizePct,
    classification: 'runner' as any,  // legacy enum value for type compat
    scores: legacyScores,
    tradeRationale: result.classification.thesis,
    keyRisk: (result.classification.keyRisks ?? []).join('; '),
    stopLoss: undefined, // targets module removed from unified flow
    targetPrice: result.yahoo?.targetMeanPrice ?? undefined,
    configSnapshot: config,
    entryAttribution,  // NEW field
  } as TradeDecision & { entryAttribution: typeof entryAttribution };
}
```

Delete the tier-based sizing block (the `sizePct = isHighConviction ? 15 : tier === 'QUALITY' ? 12.5 : 7.5`).

- [ ] **Step 3: Rewrite `evaluateSell` for category-aware holds + fade rules**

Replace `evaluateSell` with:

```typescript
async function evaluateSell(
  position: AlpacaPosition,
  analysis: PipelineResult | null,
  config: TradingConfig
): Promise<TradeDecision> {
  const ticker = position.ticker;
  const rec = analysis?.classification.recommendation ?? 'AVOID';
  const scores = analysis?.scores ?? { value: 0, catalyst: 0, upside: 0, risk: 100, attention: 0, composite: 0 } as ComponentScores;
  const legacyScores = {
    attention: scores.attention,
    momentum: scores.upside,
    fundamentals: scores.value,
    risk: scores.risk,
  };

  // Load state from portfolio_state
  const stateRows = await db.query<{
    days_held: number;
    consecutive_scan_misses: number;
    entry_date: string | null;
    entry_category: EntryCategory | null;
    entry_catalyst_date: string | null;
  }>(
    `SELECT days_held, consecutive_scan_misses, entry_date, entry_category, entry_catalyst_date
     FROM portfolio_state
     WHERE ticker = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [ticker]
  );
  const state = stateRows[0] ?? null;
  const daysHeld = state?.days_held ?? 0;
  const scanMisses = state?.consecutive_scan_misses ?? 0;
  const category = state?.entry_category ?? 'attention_momentum';

  const baseDecision = (action: 'SELL' | 'HOLD', reason: string, exitReason?: string) => ({
    ticker,
    action,
    reason,
    quantity: action === 'SELL' ? position.quantity : undefined,
    classification: rec.toLowerCase() as any,
    scores: legacyScores,
    tradeRationale: analysis?.classification.thesis,
    keyRisk: (analysis?.classification.keyRisks ?? []).join('; '),
    exitReason,
    exitAttribution: action === 'SELL' && analysis ? {
      valueScore: scores.value,
      catalystScore: scores.catalyst,
      upsideScore: scores.upside,
      riskScore: scores.risk,
      composite: scores.composite,
      reason: exitReason,
    } : undefined,
  } as any);

  // 1. AVOID reclassification
  if (rec === 'AVOID') {
    return baseDecision('SELL', `Reclassified AVOID`, 'reclass_avoid');
  }

  // 2. Category-specific max hold
  const maxHold = CATEGORY_MAX_HOLD_DAYS[category] ?? DEFAULT_MAX_HOLD_DAYS;
  if (daysHeld >= maxHold) {
    return baseDecision('SELL', `Max hold (${category}: ${daysHeld}/${maxHold}d)`, 'max_hold');
  }

  // 3. Scan miss
  if (scanMisses >= config.scanMissMax) {
    return baseDecision('SELL', `Off radar (${scanMisses} misses)`, 'scan_miss');
  }

  // 4. Category-specific fade rules
  const pnlPct = position.unrealizedPlPct;
  const catalystDate = state?.entry_catalyst_date ? new Date(state.entry_catalyst_date) : null;
  const catalystPassed = catalystDate && catalystDate.getTime() < Date.now();

  if (category === 'earnings_event' && catalystPassed && pnlPct < 3) {
    return baseDecision('SELL', `Earnings faded (P/L ${pnlPct.toFixed(1)}% < 3% after event)`, 'catalyst_fade');
  }
  if (category === 'attention_momentum' && daysHeld >= 3 && pnlPct < 2) {
    return baseDecision('SELL', `Attention faded (P/L ${pnlPct.toFixed(1)}% < 2% after ${daysHeld}d)`, 'catalyst_fade');
  }

  // HOLD
  return baseDecision('HOLD', `${category} ${daysHeld}/${maxHold}d, P/L ${pnlPct.toFixed(1)}%, misses ${scanMisses}`);
}
```

- [ ] **Step 4: Update `logDecisions` to write attribution columns**

Replace `logDecisions` with:

```typescript
export async function logDecisions(
  decisions: TradeDecision[],
  runId: string
): Promise<void> {
  for (const d of decisions) {
    if (d.action === 'BUY' || d.action === 'SELL') {
      const srRows = await db.query<{ id: number }>(
        `SELECT id FROM scan_results WHERE run_id = $1 AND ticker = $2 LIMIT 1`,
        [runId, d.ticker]
      );
      const scanResultId = srRows.length > 0 ? srRows[0].id : null;

      const entry = (d as any).entryAttribution as undefined | {
        valueScore: number; catalystScore: number; upsideScore: number;
        riskScore: number; composite: number; category: EntryCategory;
        catalystType: string; catalystDate: string | null;
      };
      const exitAttr = (d as any).exitAttribution as undefined | {
        valueScore: number; catalystScore: number; upsideScore: number;
        riskScore: number; composite: number; reason: string;
      };

      await db.query(
        `INSERT INTO trades (
          id, scan_result_id, run_id, ticker, action, quantity, order_type,
          alpaca_order_id, status, classification, confidence, scores,
          trade_rationale, key_risk, position_size_pct, stop_loss,
          target_price, config_snapshot,
          entry_value_score, entry_catalyst_score, entry_upside_score,
          entry_risk_score, entry_composite,
          entry_category, entry_catalyst_type, entry_catalyst_date,
          exit_value_score, exit_catalyst_score, exit_upside_score,
          exit_risk_score, exit_composite, exit_reason,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18,
          $19, $20, $21, $22, $23,
          $24, $25, $26,
          $27, $28, $29, $30, $31, $32,
          NOW(), NOW()
        )`,
        [
          uuidv4(), scanResultId, runId, d.ticker, d.action,
          d.quantity ?? 0, 'MKT',
          (d as any).alpacaOrderId ?? null, 'pending', d.classification,
          null, JSON.stringify(d.scores),
          d.tradeRationale ?? null, d.keyRisk ?? null,
          d.positionSizePct ?? null, d.stopLoss ?? null,
          d.targetPrice ?? null,
          d.configSnapshot ? JSON.stringify(d.configSnapshot) : null,
          entry?.valueScore ?? null, entry?.catalystScore ?? null, entry?.upsideScore ?? null,
          entry?.riskScore ?? null, entry?.composite ?? null,
          entry?.category ?? null, entry?.catalystType ?? null, entry?.catalystDate ?? null,
          exitAttr?.valueScore ?? null, exitAttr?.catalystScore ?? null, exitAttr?.upsideScore ?? null,
          exitAttr?.riskScore ?? null, exitAttr?.composite ?? null, exitAttr?.reason ?? null,
        ]
      );
    } else {
      await db.query(
        `INSERT INTO trade_decisions (id, run_id, ticker, action, reason, classification, scores, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [uuidv4(), runId, d.ticker, d.action, d.reason, d.classification, JSON.stringify(d.scores)]
      );
    }
  }
  const buys = decisions.filter(d => d.action === 'BUY').length;
  const sells = decisions.filter(d => d.action === 'SELL').length;
  const holds = decisions.filter(d => d.action === 'HOLD').length;
  const skips = decisions.filter(d => d.action === 'SKIP').length;
  console.log(`Logged ${decisions.length} decisions: ${buys} BUY, ${sells} SELL, ${holds} HOLD, ${skips} SKIP`);
}
```

- [ ] **Step 5: Update `updatePortfolioState` to write `entry_category` and `entry_catalyst_date`**

In `updatePortfolioState`, update the INSERT/UPDATE block to include the two new columns:

```typescript
    await db.query(
      `INSERT INTO portfolio_state (
        id, run_id, ticker, quantity, avg_entry_price, current_price,
        unrealized_pl_pct, entry_date, days_held, classification_at_entry,
        stop_loss, target_price, consecutive_scan_misses,
        entry_category, entry_catalyst_date,
        created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15,
        NOW()
      )
      ON CONFLICT (run_id, ticker) DO UPDATE SET
        quantity = EXCLUDED.quantity,
        avg_entry_price = EXCLUDED.avg_entry_price,
        current_price = EXCLUDED.current_price,
        unrealized_pl_pct = EXCLUDED.unrealized_pl_pct,
        days_held = EXCLUDED.days_held,
        stop_loss = EXCLUDED.stop_loss,
        target_price = EXCLUDED.target_price,
        consecutive_scan_misses = EXCLUDED.consecutive_scan_misses`,
      [
        uuidv4(),
        runId,
        pos.ticker,
        pos.quantity,
        pos.avgEntryPrice,
        pos.currentPrice,
        pos.unrealizedPlPct,
        entryDate,
        daysHeld,
        classificationAtEntry,
        stopLoss,
        targetPrice,
        scanMisses,
        analysis?.entryCategory.category ?? prev?.entry_category ?? null,
        analysis?.entryCategory.catalystDate ?? prev?.entry_catalyst_date ?? null,
      ]
    );
```

Also add `entry_category` and `entry_catalyst_date` to the `prevRows` SELECT query:

```typescript
    const prevRows = await db.query<{
      consecutive_scan_misses: number;
      entry_date: string | null;
      days_held: number;
      classification_at_entry: string | null;
      stop_loss: number | null;
      target_price: number | null;
      entry_category: EntryCategory | null;
      entry_catalyst_date: string | null;
    }>(
      `SELECT consecutive_scan_misses, entry_date, days_held, classification_at_entry, stop_loss, target_price, entry_category, entry_catalyst_date
       FROM portfolio_state
       WHERE ticker = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [pos.ticker]
    );
```

- [ ] **Step 6: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: clean. Any remaining errors mean a type mismatch I missed — fix in place.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/trader.ts
git commit -m "refactor: trader uses unified scoring, category holds, attribution logging"
```

---

# PHASE G — LOCAL DRY RUN + DEPLOY

## Task G1: Local dry-run against prod DB with trading disabled

**Files:** (runtime only, no file changes)

- [ ] **Step 1: Disable trading in prod DB**

Run:
```bash
cd backend && cat > /tmp/disable.ts <<'EOF'
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  await pool.query("UPDATE trading_config SET enabled = false WHERE id = 1");
  console.log('disabled');
  await pool.end();
})();
EOF
DATABASE_URL='postgresql://postgres:WMxIRbXdhNvmSMIBIayQYyfSXeATlQCE@switchyard.proxy.rlwy.net:15765/railway' npx tsx /tmp/disable.ts
rm /tmp/disable.ts
```

Expected: `disabled`.

- [ ] **Step 2: Run pipeline locally with full env**

Run:
```bash
cd backend && \
DATABASE_URL='postgresql://postgres:WMxIRbXdhNvmSMIBIayQYyfSXeATlQCE@switchyard.proxy.rlwy.net:15765/railway' \
ALPACA_API_KEY=PKFBKKMLIBQT2YLJMFKZMO5RU2 \
ALPACA_API_SECRET=63ycSwkU9tYKdC74X5Hj6tFcDAVhWivdCJsJVZa2sxyK \
ALPACA_PAPER=true \
ALPHA_VANTAGE_API_KEY=vAX02SJ9543I0E8F2 \
FINNHUB_API_KEY=<FINNHUB_API_KEY> \
MAX_TICKERS=25 \
PERPLEXITY_API_KEY=<PERPLEXITY_API_KEY> \
npm run pipeline
```

Expected: pipeline completes without exceptions. Summary prints with BUY/WATCH/AVOID breakdown + tradeable count + top 10 by composite with component scores.

- [ ] **Step 3: Inspect the run in DB**

Run:
```bash
cat > /tmp/inspect.ts <<'EOF'
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const latest = await pool.query("SELECT run_id FROM scan_runs ORDER BY run_timestamp DESC LIMIT 1");
  const runId = latest.rows[0].run_id;
  console.log('run_id:', runId);
  const rows = await pool.query(`
    SELECT ticker, classification, tradeable, gate_failures, value_score, catalyst_score, emerging_industry_score AS upside_score, risk_score, thesis
    FROM scan_results WHERE run_id = $1
    ORDER BY (value_score * 0.30 + catalyst_score * 0.35 + emerging_industry_score * 0.25 - risk_score * 0.15) DESC
  `, [runId]);
  for (const r of rows.rows) {
    const comp = Math.round(r.value_score * 0.30 + r.catalyst_score * 0.35 + r.upside_score * 0.25 - r.risk_score * 0.15);
    console.log(`  ${r.ticker.padEnd(6)} ${r.classification.padEnd(6)} trade=${r.tradeable} comp=${comp} V=${r.value_score} C=${r.catalyst_score} U=${r.upside_score} R=${r.risk_score} ${r.tradeable ? '' : '['+JSON.stringify(r.gate_failures)+']'}`);
    console.log(`         ${String(r.thesis).slice(0, 120)}`);
  }
  await pool.end();
})();
EOF
DATABASE_URL='postgresql://postgres:WMxIRbXdhNvmSMIBIayQYyfSXeATlQCE@switchyard.proxy.rlwy.net:15765/railway' npx tsx /tmp/inspect.ts
rm /tmp/inspect.ts
```

Expected:
- Mix of BUY / WATCH / AVOID classifications (not all one thing)
- Mix of tradeable = true / false rows
- Gate failures array populated for non-tradeable rows
- Composite scores and component scores in reasonable ranges
- Thesis strings actually descriptive (not fallback text)

**Manual judgment call:** do the top 10 candidates look like reasonable value + catalyst plays, or like junk? If junk, stop and investigate before proceeding.

- [ ] **Step 4: Commit (no file changes, record progress)**

```bash
git commit --allow-empty -m "chore: verified local dry-run against prod DB"
```

---

## Task G2: Apply trading_config updates + deploy backend

- [ ] **Step 1: Apply trading_config SQL**

Run:
```bash
cat > /tmp/cfg.ts <<'EOF'
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  await pool.query(`UPDATE trading_config SET
    max_position_pct = 15,
    max_portfolio_heat_pct = 60,
    min_fundamentals = 55,
    max_risk = 45,
    min_momentum = 20,
    hold_days_max = 35,
    quality_hold_days_max = 35,
    high_conviction_size_pct = 14,
    scan_miss_max = 6,
    updated_at = NOW()
    WHERE id = 1`);
  const r = await pool.query("SELECT * FROM trading_config WHERE id = 1");
  console.log(r.rows[0]);
  await pool.end();
})();
EOF
DATABASE_URL='postgresql://postgres:WMxIRbXdhNvmSMIBIayQYyfSXeATlQCE@switchyard.proxy.rlwy.net:15765/railway' npx tsx /tmp/cfg.ts
rm /tmp/cfg.ts
```

Expected: prints updated config row with all new values.

- [ ] **Step 2: Push to GitHub (Railway auto-deploys backend)**

Run:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener
git push
```

Expected: push succeeds. Check Railway dashboard briefly to confirm deployment started.

- [ ] **Step 3: Wait for next cron run, verify scan_results**

Run (after ~5 min to let a cron fire and write to DB):
```bash
cat > /tmp/check.ts <<'EOF'
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await pool.query("SELECT run_timestamp, status, tickers_scanned FROM scan_runs ORDER BY run_timestamp DESC LIMIT 3");
  for (const row of r.rows) console.log(row.run_timestamp.toISOString(), row.status, row.tickers_scanned);
  const latest = r.rows[0]?.run_timestamp;
  if (latest) {
    const s = await pool.query("SELECT classification, tradeable, COUNT(*) FROM scan_results WHERE run_timestamp = $1 GROUP BY classification, tradeable ORDER BY classification", [latest]);
    for (const row of s.rows) console.log('  ', row.classification, 'tradeable='+row.tradeable, row.count);
  }
  await pool.end();
})();
EOF
DATABASE_URL='postgresql://postgres:WMxIRbXdhNvmSMIBIayQYyfSXeATlQCE@switchyard.proxy.rlwy.net:15765/railway' npx tsx /tmp/check.ts
rm /tmp/check.ts
```

Expected: latest cron run completed with non-zero ticker count, classification breakdown shows a mix.

---

## Task G3: Reset Alpaca paper account + re-enable trading

- [ ] **Step 1: Reset Alpaca paper account**

**Manual action:** Log into https://app.alpaca.markets (paper trading), click the reset button on the paper account to start fresh $100k. Any existing positions from old penny-stock logic are wiped. This is a one-click UI action.

- [ ] **Step 2: Re-enable trading**

Run:
```bash
cat > /tmp/enable.ts <<'EOF'
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  await pool.query("UPDATE trading_config SET enabled = true WHERE id = 1");
  console.log('enabled');
  await pool.end();
})();
EOF
DATABASE_URL='postgresql://postgres:WMxIRbXdhNvmSMIBIayQYyfSXeATlQCE@switchyard.proxy.rlwy.net:15765/railway' npx tsx /tmp/enable.ts
rm /tmp/enable.ts
```

Expected: `enabled`.

- [ ] **Step 3: Wait for next cron + verify trades appear**

After ~5 min:
```bash
cat > /tmp/trades.ts <<'EOF'
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const t = await pool.query("SELECT ticker, action, status, entry_category, entry_composite, entry_value_score, entry_catalyst_score FROM trades ORDER BY created_at DESC LIMIT 10");
  console.log('Recent trades:');
  for (const r of t.rows) console.log('  ', r.action, r.ticker, r.status, r.entry_category, 'comp='+r.entry_composite, 'V='+r.entry_value_score, 'C='+r.entry_catalyst_score);
  const d = await pool.query("SELECT action, COUNT(*) FROM trade_decisions WHERE created_at > NOW() - INTERVAL '1 hour' GROUP BY action");
  console.log('Decisions last hour:', d.rows);
  await pool.end();
})();
EOF
DATABASE_URL='postgresql://postgres:WMxIRbXdhNvmSMIBIayQYyfSXeATlQCE@switchyard.proxy.rlwy.net:15765/railway' npx tsx /tmp/trades.ts
rm /tmp/trades.ts
```

Expected: at least some decisions logged (BUY/SKIP/HOLD). If any BUYs placed, attribution columns populated.

- [ ] **Step 4: Commit (progress marker)**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener && git commit --allow-empty -m "chore: unified screener live in paper trading"
```

---

# PHASE H — FRONTEND UPDATES

## Task H1: Update `db.ts` types + main dashboard row display

**Files:**
- Modify: `web-dashboard/src/lib/db.ts`
- Modify: `web-dashboard/src/routes/+page.svelte`

- [ ] **Step 1: Extend `ScanResult` interface**

In `web-dashboard/src/lib/db.ts`, find the `ScanResult` interface. Add:

```typescript
  tradeable: boolean | null;
  gate_failures: string[] | null;
```

- [ ] **Step 2: Update main dashboard to show new columns**

In `web-dashboard/src/routes/+page.svelte`:

1. Find the column headers. Remove the "Tier" column. Add a "Tradeable" column (just a green dot or red dot with tooltip listing gate failures) and a "Composite" column.
2. Find the row rendering. Replace the tier badge with a BUY/WATCH/AVOID badge based on `row.classification`.
3. Update the sorting to default by composite (compute from component scores).

**Concrete changes** — find the table header row (search for `<th>Tier</th>`):

Replace `<th>Tier</th>` with:

```svelte
<th>Status</th>
<th>Trade</th>
<th>Composite</th>
```

Find the corresponding `<td>` cells in the row loop. Replace the tier cell (something like `{row.tier}` rendered with a class) with:

```svelte
<td>
  <span class="badge badge-{row.classification?.toLowerCase() ?? 'watch'}">{row.classification ?? 'WATCH'}</span>
</td>
<td>
  {#if row.tradeable}
    <span class="dot dot-green" title="Tradeable"></span>
  {:else}
    <span class="dot dot-red" title={row.gate_failures ? row.gate_failures.join(', ') : 'Not tradeable'}></span>
  {/if}
</td>
<td class="composite">
  {Math.round(
    (row.fundamentals_score ?? 0) * 0.30 +
    (row.catalyst_score ?? 0) * 0.35 +
    (row.emerging_industry_score ?? 0) * 0.25 -
    (row.risk_score ?? 0) * 0.15
  )}
</td>
```

Add CSS in the `<style>` block:

```css
.badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.badge-buy { background: rgba(16, 185, 129, 0.2); color: #10b981; }
.badge-watch { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
.badge-avoid { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
.dot-green { background: #10b981; }
.dot-red { background: #ef4444; }
.composite { font-weight: 600; text-align: right; }
```

- [ ] **Step 3: Typecheck the frontend**

Run: `cd web-dashboard && npx svelte-check --threshold error 2>&1 | tail -20`
Expected: no new errors beyond the 21 pre-existing ones from prior work.

- [ ] **Step 4: Commit**

```bash
git add web-dashboard/src/lib/db.ts web-dashboard/src/routes/+page.svelte
git commit -m "feat(frontend): dashboard shows BUY/WATCH/AVOID + tradeable + composite"
```

---

## Task H2: Deploy frontend to Vercel

- [ ] **Step 1: Push and deploy**

Run:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener && git push
cd web-dashboard && vercel --prod
```

Expected: deploy succeeds, URL returned.

- [ ] **Step 2: Smoke test the live URL**

Manually visit https://web-dashboard-bice.vercel.app/ and verify:
- Main dashboard loads without errors
- Rows show BUY/WATCH/AVOID badges
- Tradeable green/red dots present
- Composite column populated
- No tier column visible

- [ ] **Step 3: Commit marker**

```bash
git commit --allow-empty -m "chore: unified screener frontend live on Vercel"
```

---

## Task H3 (OPTIONAL, follow-up PR): Ticker detail page, portfolio AI trades, attribution tab

These are listed in the spec but are lower priority and can wait until after the system has been observed for a few days. Skip for this plan unless explicitly requested. Track as follow-up work:

- `routes/ticker/[symbol]/+page.svelte` — thesis hero showing new classifier output
- `routes/portfolio/+page.svelte` — AI Trades tab with entry_category column + component breakdown
- `routes/analytics/+page.svelte` — Attribution tab (win rate by category, scatter, component bucket hit rates)

---

# Self-review checklist

1. **Spec coverage:**
   - Pipeline refactor (dual-tier → single): covered by E2/E3 ✓
   - New Finviz queries: covered by C1 ✓
   - Yahoo quoteSummary: covered by A4 ✓
   - Insider transactions wired: covered by C2 ✓
   - Sector medians: covered by A3 ✓
   - Tradeability gates: covered by A5 ✓
   - Component scoring: covered by B1 ✓
   - Classifier rewrite: covered by D1 ✓
   - Trader category logic + attribution: covered by F1 ✓
   - DB migration 009: covered by A1 ✓
   - New types: covered by A2 ✓
   - trading_config SQL update: covered by G2 ✓
   - Local dry-run: covered by G1 ✓
   - Alpaca reset + re-enable: covered by G3 ✓
   - Frontend dashboard updates: covered by H1/H2 ✓
   - Ticker detail / portfolio / analytics attribution tab: intentionally deferred to H3 (follow-up PR)

2. **Placeholder scan:** No TBDs. All code blocks contain real code. Exact commands and expected outputs in every verification step.

3. **Type consistency:**
   - `ComponentScores` shape used consistently across scoring.ts, trader.ts, pipeline.ts ✓
   - `EntryCategory` union consistent ✓
   - `UnifiedClassification` shape matches classifier.ts output and consumer in pipeline.ts ✓
   - `CATEGORY_MAX_HOLD_DAYS` + `DEFAULT_MAX_HOLD_DAYS` exported from categoryClassification.ts and imported in trader.ts ✓
   - `TradeabilityResult` flows from lib/tradeability.ts → pipeline.ts → trader.ts ✓

All consistent.
