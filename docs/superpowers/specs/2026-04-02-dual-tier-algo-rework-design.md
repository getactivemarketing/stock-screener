# Dual-Tier Algorithm Rework — Design Spec

**Date:** 2026-04-02
**Status:** Approved
**Scope:** Rework the screener from a penny stock hype detector into a dual-tier momentum + value system with catalyst awareness and emerging industry scoring.

---

## Overview

Replace the current single-tier penny stock screener with a two-tier system:

- **MOMENTUM tier** (price < $20): Retail-driven, sentiment-first. Short-term holds (1-5 days), 10-30% targets. This is the existing pipeline's core identity, preserved.
- **QUALITY tier** ($20-$100, market cap > $500M, avg volume > 750K): Institutional-grade, fundamentals-first. Medium holds (3-20 days), 8-25% targets. New tier focused on undervalued stocks with catalysts and emerging industry tailwinds.

The classifier prompt evaluates every stock through three lenses: **Value** (undervaluation), **Catalyst** (imminent price triggers), and **Emerging Industry** (secular trend tailwinds). Each scored 0-10 by Perplexity.

---

## 1. Tier System & Universe Selection

### Tier Assignment

| | MOMENTUM | QUALITY |
|--|----------|---------|
| **Filter** | Price < $20 | Price $20-$100, market cap > $500M, avg volume > 750K |
| **Ranked by** | Attention score | Fundamentals + Momentum composite |
| **Min threshold** | Attention >= 40 | Fundamentals >= 50 |
| **Per-tier cap** | 25 | 25 |
| **Soft floor** | 10 | 5 |
| **Combined hard cap** | 40 | |

### Dynamic Allocation Logic

1. Score both candidate pools independently
2. Apply minimum thresholds as gates
3. Take up to 25 from each tier
4. Enforce soft floors: minimum 10 MOMENTUM, minimum 5 QUALITY
5. If a tier can't hit its floor, fill from the other tier's next-best candidates
6. Combined hard cap of 40

Typical run: ~20 MOMENTUM + ~15 QUALITY = ~35 tickers. On quiet days might be 25 total. On high-signal days, up to 40.

### Pipeline Integration

Tier assignment happens in Step 3 (candidate selection). The `tier` field flows through the entire pipeline: scoring, classification, trading, database, and dashboard.

### Analytics

Log tier breakdown per run to the `scan_runs` table (new columns: `momentum_count INT`, `quality_count INT`). After 2-3 weeks this provides evidence-based data to adjust soft floors.

---

## 2. Finnhub Classifier Enrichment

### New function: `enrichForClassifier(ticker: string)` in `finnhub.ts`

Fires three Finnhub API calls in parallel via `Promise.all`. If any call fails or times out, log the error and return `null` for that field. Never fail the pipeline.

### Analyst Ratings

**Endpoints:** `/stock/recommendation` + `/stock/price-target`

- `/stock/recommendation` returns a time-series of buy/hold/sell counts by month. Take the most recent entry and sum counts into a label: `"Strong Buy: 12, Buy: 8, Hold: 3, Sell: 1"`
- `/stock/price-target` returns mean, high, and low analyst price targets
- For MOMENTUM tier, frequently null — pass as `"No analyst coverage"`

### Earnings

**Endpoint:** `/calendar/earnings`

- Pass `from` and `to` as a 60-day forward window, filter by ticker
- Returns next earnings date + EPS estimates (actual vs consensus)
- Extract `epsEstimate` and last 4 quarters of surprise history
- Compute `earningsBeatRate`: percentage of last 4 quarters where actual > estimate (0-100%)
- Watch rate limits since this is called for up to 40 tickers per run

### News Headlines

**Strategy:** Finviz first, Finnhub `/company-news` as fallback

- If Finviz already has headlines for the ticker from earlier in the pipeline, use those (saves rate limit budget)
- Otherwise, Finnhub `/company-news` with `from` = 7 days ago, `to` = today
- Take 3-5 most recent headlines by datetime
- Headline text only — no article body (prevents token bloat in Perplexity call)

### Output Type

```typescript
interface ClassifierEnrichment {
  analystRatings: {
    summary: string;           // "Strong Buy: 12, Buy: 8, Hold: 3, Sell: 1"
    meanTarget: number | null;
    highTarget: number | null;
    lowTarget: number | null;
  } | null;
  earnings: {
    nextDate: string | null;
    daysToEarnings: number | null;
    epsEstimate: number | null;
    earningsBeatRate: number | null;  // 0-100, last 4 quarters
  } | null;
  newsHeadlines: string[] | null;     // 3-5 recent headlines
}
```

### Pipeline Position

Runs as Step 6.5: after technical indicators (Step 6), before scoring & classification (Step 7). Rate-limited via the existing `finnhub` RateLimiter (1 concurrent, 1.5s delay).

---

## 3. Tier-Aware Fundamentals Score

### MOMENTUM Tier — Existing Formula (unchanged)

- Base: 50 points
- Market cap: -15 to +15
- P/E ratio: -5 to +10
- Revenue growth: -10 to +15
- Gross margin: -5 to +10
- Operating margin: -5 to +10
- Debt/equity: -10 to +5
- Exchange bonus: +5 (NYSE/NASDAQ)

### QUALITY Tier — New Formula

| Component | Weight | Logic |
|-----------|--------|-------|
| Price-to-analyst-target distance | 30 pts | `(meanTarget - price) / price`. 25%+ implied upside = 30 pts. Linear scale down. No data = 0. |
| Forward P/E vs sector median | 30 pts | Relative cheapness. Trading at 70% of sector median = 30 pts. At 100% = 15 pts. Above 130% = 0 pts. Linear interpolation. |
| Earnings beat rate | 20 pts | Last 4 quarters. 100% = 20, 75% = 15, 50% = 10, 25% = 5, 0% = 0. Null = 10 (neutral). |
| Existing checks (margins, debt, growth) | 20 pts | Same logic as MOMENTUM but scaled to 20 points max. |

### Sector Median P/E Lookup (hardcoded v1)

| Sector | Forward P/E Median |
|--------|-------------------|
| Technology | 28x |
| Biotech / Life Sciences | 35x |
| Energy | 12x |
| Industrials | 18x |
| Healthcare | 22x |
| Financials | 14x |
| Consumer Discretionary | 22x |
| Consumer Staples | 20x |
| Utilities | 16x |
| Real Estate | 18x |
| Materials | 15x |
| Communication Services | 20x |
| Default (unknown sector) | 20x |

### Implementation

Single conditional in `scoring.ts`:

```typescript
if (tier === 'QUALITY') {
  return computeQualityFundamentals(price, fundamentals, enrichment);
} else {
  return computeMomentumFundamentals(fundamentals); // existing formula
}
```

Output: 0-100 score in the same `fundamentals_score` field. The `>= 60` gate in `trader.ts` applies to both tiers.

---

## 4. Updated Classifier Prompt & Output

### Prompt

The existing `buildPrompt()` in `classifier.ts` is replaced entirely with the dual-tier prompt. The prompt:

- Receives all existing scores (attention, momentum, fundamentals, risk) plus enrichment data (analyst ratings, earnings, news)
- Evaluates through three lenses: Value (0-10), Catalyst (0-10), Emerging Industry (0-10)
- Applies tier-specific evaluation criteria (MOMENTUM = sentiment + breakout; QUALITY = valuation + mispricing + catalyst)
- Returns structured JSON with richer output than the current classifier

### New Classifier Output

```json
{
  "classification": "runner | value | both | watch | avoid",
  "tier": "MOMENTUM | QUALITY",
  "confidence": 0.0-1.0,
  "value_score": 0-10,
  "catalyst_score": 0-10,
  "emerging_industry_score": 0-10,
  "thesis": "2-3 sentences",
  "edge_why_now": "1-2 sentences on why this week",
  "bull_case": "Best-case outcome",
  "bear_case": "What invalidates the thesis",
  "key_risk": "Single most important risk",
  "catalysts": ["list", "of", "upcoming", "catalysts"],
  "industry_theme": "e.g. 'AI power infrastructure' or null",
  "trade_rationale": "One punchy sentence",
  "suggested_position_pct": 5-15,
  "target_price": {
    "target": 0.00,
    "reasoning": "Brief reasoning",
    "confidence": 0.0-1.0
  },
  "stop_loss_pct": -10 to -20,
  "expected_returns": { "1m": "+X%", "3m": "+X%", "12m": "+X%" }
}
```

### Classification Rules

- **runner**: Strong momentum + imminent catalyst OR accelerating retail attention. Primarily MOMENTUM tier.
- **value**: Fundamentally undervalued with near-term catalyst. Primarily QUALITY tier.
- **both**: Meets runner AND value criteria. Rare — highest conviction.
- **watch**: Interesting but missing one key ingredient.
- **avoid**: No clear edge or risk too high.

### Position Sizing (from classifier)

- MOMENTUM tier: default 5-10%
- QUALITY tier: default 10-15%
- High conviction (all lens scores >= 7, risk < 30): up to 15%

Note: `suggested_position_pct` remains advisory only — actual sizing goes through `risk.ts`.

---

## 5. Database Schema Changes

### New columns on `scan_results`

```sql
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS tier VARCHAR(10);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS value_score SMALLINT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS catalyst_score SMALLINT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS emerging_industry_score SMALLINT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS thesis TEXT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS edge_why_now TEXT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS industry_theme VARCHAR(100);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS stop_loss_pct DECIMAL(5,2);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS expected_returns JSONB;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS analyst_mean_target DECIMAL(10,2);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS analyst_summary TEXT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS earnings_date DATE;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS days_to_earnings INT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS earnings_beat_rate DECIMAL(5,2);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS news_headlines TEXT[];
```

### New columns on `scan_runs`

```sql
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS momentum_count INT;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS quality_count INT;
```

### Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_scan_results_tier ON scan_results(tier);
CREATE INDEX IF NOT EXISTS idx_scan_results_industry_theme ON scan_results(industry_theme);
```

Existing columns reused: `classification`, `confidence`, `bull_case`, `bear_case`, `catalysts`, `trade_rationale`, `key_risk`, `target_price`-related fields, `stop_loss`.

---

## 6. Trader.ts Changes

### Position Sizing by Tier

```typescript
// Default sizing
const defaultSizePct = tier === 'QUALITY' ? 12.5 : 7.5; // midpoint of each range

// High conviction: all 3 lens scores >= 7 AND risk < 30
const isHighConviction =
  valueScore >= 7 && catalystScore >= 7 && emergingIndustryScore >= 7 &&
  scores.risk < 30;

const sizePct = isHighConviction ? 15 : defaultSizePct;
```

### Stop-Loss Source

Use `stop_loss_pct` from the classifier output when available (percentage-based), falling back to the technical `stop_loss` price from `targets.ts`. The classifier's stop-loss is more contextually aware (it factors in tier and volatility profile).

### Hold Period

- MOMENTUM: `hold_days_max` stays at 5 (from `trading_config`)
- QUALITY: consider adding a `quality_hold_days_max` to `trading_config` (default 15) for longer holds

This is a minor addition to the `trading_config` table:

```sql
ALTER TABLE trading_config ADD COLUMN IF NOT EXISTS quality_hold_days_max INT DEFAULT 15;
```

---

## 7. Pipeline Flow (Revised)

```
Step 1:  Fetch sentiment (6 sources — unchanged)
Step 2:  Merge by ticker (unchanged)
Step 3:  Select candidates (REWORKED — dual-tier dynamic allocation)
Step 4:  Enrich with market data (unchanged — Finnhub quotes + profiles)
Step 5:  Apply universe filters (SIMPLIFIED — tier handles filtering)
Step 6:  Calculate technicals (unchanged — RSI, MACD, Bollinger, SMAs)
Step 6.5: Classifier enrichment (NEW — analyst ratings, earnings, news)
Step 7:  Score & Classify (MODIFIED — tier-aware fundamentals + new prompt)
Step 8:  Save results (MODIFIED — new columns)
Step 9:  Automated trading (MODIFIED — tier-aware sizing + hold period)
Step 10: Update run record (MODIFIED — log tier breakdown)
```

### Rate Limit Budget (typical 35-ticker run)

- Existing enrichment: ~70 Finnhub calls (quotes + profiles) @ 1.5s each
- New enrichment: ~105 calls (3 per ticker) but parallelized per ticker = ~35 batches @ 1.5s
- Perplexity: ~35 calls (sequential, ~2s each)
- Total: ~5-7 minutes. Fits in the 30-minute cron window.

---

## 8. Files Changed

### New Files
| File | Responsibility |
|------|---------------|
| `database/migration-008-dual-tier.sql` | Schema: new columns on scan_results, scan_runs, trading_config |

### Modified Files
| File | Changes |
|------|---------|
| `backend/src/services/finnhub.ts` | Add `enrichForClassifier()` — analyst ratings, earnings, news |
| `backend/src/services/scoring.ts` | Tier-aware fundamentals: `computeQualityFundamentals()` + sector median table |
| `backend/src/services/classifier.ts` | Replace prompt with dual-tier version, update output parsing for new fields |
| `backend/src/services/trader.ts` | Tier-aware position sizing, stop-loss from classifier, quality hold period |
| `backend/src/pipeline.ts` | Step 3 rework (dynamic allocation), Step 6.5 (enrichment), save new columns |
| `backend/src/types/index.ts` | Add `ClassifierEnrichment`, update `AnalysisWithTarget`, add `tier` field |
| `backend/src/services/backtest.ts` | Update `simulateTrading()` for tier-aware sizing |

---

## Out of Scope (v1)

- Full rework of attention, momentum, or risk scores (v1.5 — after data validates)
- Live trading (paper only)
- Dashboard UI changes for tier/lens display (existing pages work, enhancement later)
- Sector median P/E from live data (hardcoded lookup for v1)
- Adjusting the `>= 60` fundamentals gate by tier (validate with data first)
- Expanding QUALITY to > $100 stocks (start with $20-$100 range)
