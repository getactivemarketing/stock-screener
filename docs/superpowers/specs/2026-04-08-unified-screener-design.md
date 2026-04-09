# Unified Value + Catalyst Screener — Design

**Date:** 2026-04-08
**Status:** Draft, pending implementation
**Replaces:** Dual-tier (MOMENTUM/QUALITY) architecture from 2026-04-02

## Intent

Shift the screener from a penny-stock sentiment chaser to a **value + catalyst screener across the full US equity universe**. The agent analyzes any stock, at any price, and picks the best-ranked opportunities based on:

1. **Value** — is this mispriced? (analyst upside, fundamentals, cheap multiples)
2. **Catalyst** — is something concrete about to happen? (earnings, insider buying, upgrades)
3. **Upside potential** — technical tailwinds
4. **Risk** — penalty subtracted

Penny stocks are not excluded but are not privileged. They compete on the same criteria as mega-caps. The MOMENTUM/QUALITY tier distinction is retired.

## Non-goals

- Historical backfill of new scoring on old `scan_results` rows.
- Renaming or dropping the `tier` column (kept for backward compatibility with historical rows).
- Adding new data sources beyond Yahoo `quoteSummary` (Seeking Alpha, FDA calendar, institutional holdings, etc. are parked for future work).
- Changing the `/performance` calendar page — still valid as-is.
- Day-trading style intraday re-entries.

---

## Architecture

### Pipeline steps (collapsed from 9 to 8)

| # | Step | Change |
|---|---|---|
| 1 | Fetch candidates | Broadened sources (see below) — no more penny bias |
| 2 | Merge by ticker | No tier marking; single-score pre-rank |
| 3 | Pre-rank + select top N | Replaces `selectTickersWithDualTier` |
| 4 | Enrich price + fundamentals | Finnhub + **Yahoo `quoteSummary` (NEW)** for analyst targets & valuation |
| 5 | Apply universe filters | Price gates deleted. Kept: US-only, ETF/ADR exclusion, liquidity floor |
| 6 | Technical indicators | Unchanged |
| 7 | Classifier enrichment | Unchanged + **Finnhub `fetchInsiderTransactions` wired in** |
| 8 | Score + classify + save + trade | Single scoring path, simplified classifier, retuned trader |

### Data sources

**Finviz (reworked — 6 queries, no price cap):**
1. Value setups — `fa_pe_u15,fa_pb_u3,sh_avgvol_o500`
2. Analyst upgrades — `an_recom_buybetter,sh_avgvol_o500`
3. Earnings catalysts — `earningsdate_nextdays5,sh_avgvol_o500`
4. Insider buying — `ins_ownership_pos,sh_insidertrans_veryposlarge`
5. Unusual volume — `sh_relvol_o2,sh_avgvol_o500`
6. Oversold bounce candidates — `ta_rsi_os30,fa_curratio_o1,sh_avgvol_o500`

**Yahoo Finance `quoteSummary` (NEW, free, no auth):**
- Endpoint: `https://query1.finance.yahoo.com/v10/finance/quoteSummary/{ticker}?modules=financialData,defaultKeyStatistics,summaryDetail`
- Returns: `targetMeanPrice`, `targetHighPrice`, `targetLowPrice`, `recommendationMean`, `numberOfAnalystOpinions`, 52w range, trailing/forward P/E, P/B, P/S
- Replaces the now-short-circuited Finnhub `/stock/price-target` (paid endpoint, 403s on free tier)
- New file: `backend/src/services/yahoo.ts`

**Finnhub (kept):** quote, profile2, metric, recommendation, earnings calendar, news, **insider transactions (newly wired into `enrichForClassifier`)**.

**ApeWisdom & Stocktwits (demoted):** still called but contribute only to the tie-breaker `attention_rank`, not the composite score.

**Reddit:** already deleted (April 7).

### Universe funnel

```
Finviz 6 screens          ~200-500 tickers
+ ApeWisdom (all filters) +  ~100
+ Stocktwits trending     +   ~50
─────────────────────────────────
= merged universe         ~300-600 unique tickers
→ pre-rank by cheap composite (sourcing metadata only, no API calls)
→ top 30 for enrichment (Finnhub + Yahoo)
→ drop any that fail hard tradeability gates → mark tradeable=false but keep in scan_results
→ all analyzed + classified + scored
→ trader evaluates tradeable BUYs only
```

---

## Scoring model

### Composite formula

```
composite = 0.30 * value + 0.35 * catalyst + 0.25 * upside - 0.15 * risk
```

Range: approximately -15 to 90. BUY threshold: composite ≥ 65 AND risk ≤ 45.

**Attention is NOT in the composite.** It is stored separately as `attention_rank` and used ONLY as a tie-breaker when two composite scores are within 2 points.

### Value score (0-100, weight 30%)

| Component | Max Points | Source |
|---|---|---|
| Analyst target upside | 25 | Yahoo `targetMeanPrice` vs current price |
| Forward revenue growth | 15 | Finnhub `revenueGrowthTTMYoy` |
| Gross margin level | 10 | Finnhub `grossMarginTTM` |
| Operating margin (FCF proxy) | 10 | Finnhub `operatingMarginTTM` |
| P/E vs sector median | 20 | Finnhub `peBasicExclExtraTTM` |
| P/B vs sector median | 10 | Finnhub `pbQuarterly` |
| Distance from 52w high | 10 | Computed |

**Sector medians** (hardcoded in `backend/src/services/sectorMedians.ts`, starting values):

| Sector | P/E median | P/B median |
|---|---|---|
| Technology | 25 | 4.0 |
| Consumer Discretionary | 22 | 3.0 |
| Healthcare | 20 | 3.5 |
| Communication Services | 20 | 3.0 |
| Industrials | 18 | 2.5 |
| Real Estate | 20 | 2.0 |
| Consumer Staples | 20 | 3.5 |
| Materials | 15 | 2.0 |
| Utilities | 18 | 1.8 |
| Energy | 10 | 1.5 |
| Financials | 12 | 1.2 |
| Unknown / default | 18 | 2.5 |

Scoring function: if ticker P/E is 30%+ below sector median → max points. Linear interpolation to 0 at sector median. Negative P/E → 0 points (loss-making — handled by revenue growth instead).

### Catalyst score (0-100, weight 35%)

| Component | Max Points | Source |
|---|---|---|
| Days to next earnings | 30 | Finnhub earnings calendar |
| Historical earnings beat rate (last 4 Q) | 20 | Finnhub earnings calendar |
| Analyst recommendation consensus | 20 | Finnhub recommendation |
| Insider buying last 90 days | 20 | Finnhub `fetchInsiderTransactions` |
| News recency (last 3 days) | 10 | Finnhub company news |

Days to earnings: ≤5d→30pts, 6-10d→25pts, 11-20d→15pts, 21-35d→8pts, >35d→0pts.
Beat rate: 4/4→20pts, 3/4→15, 2/4→10, ≤1/4→0.
Recommendation: Strong Buy→20, Buy→15, Hold→8, Sell→0.
Insider buying: ≥1 large buy (>$100k) in last 90d→20pts; any buy→10pts; none→0pts; net selling→-5pts.

### Upside score (0-100, weight 25%)

| Component | Max Points | Source |
|---|---|---|
| Relative volume | 25 | Finnhub metrics |
| 30d price momentum | 25 | Computed |
| RSI in healthy zone (35-65) | 15 | Technicals |
| Technical signal bullish | 20 | Existing `technicalSignal` |
| Multi-screen hits (2+ Finviz screens) | 15 | `sourceCount` for finviz sub-sources |

### Risk score (0-100, weight -15% in composite)

| Component | Max Points | Rationale |
|---|---|---|
| High debt/equity (>2.0) | 25 | Leverage risk |
| Negative or zero revenue growth | 20 | Business declining |
| Small cap ($300M-$2B) | 15 | Volatility + liquidity |
| Micro cap (< $300M) | n/a → HARD GATE | Blocks entry entirely |
| High short interest (>20% if available) | 15 | Crowding risk |
| No analyst coverage (<2 analysts) | n/a → HARD GATE | Blocks entry entirely |
| Negative operating margin | 15 | Unprofitable |
| Stock price under $2 | n/a → HARD GATE | Blocks entry entirely |
| High volatility (implied or realized) | 10 | If available |

### Hard tradeability gates

**All must pass**, or row is marked `tradeable = false` and trader skips it (but it still appears in scan_results with its score):

1. **Price ≥ $2.00** — no pump territory
2. **Market cap ≥ $300M** — no micro caps
3. **Average daily dollar volume ≥ $5M** — `price × avgVolume30d`
4. **Analyst coverage ≥ 2** — Yahoo `numberOfAnalystOpinions ≥ 2`
5. **US-listed, not ETF/ADR** — existing filters
6. **Earnings not imminent** — if next earnings date is within 24 hours (either before or after market close tomorrow), block entry. Prevents buying into an earnings gap.

Failing gates are logged to `scan_results.gate_failures` (text array) for dashboard display.

### Classification

Three states, replacing the retired `runner/value/both/avoid/watch`:

- **BUY** — composite ≥ 65 AND risk ≤ 45 AND `tradeable = true`
- **WATCH** — composite 50-65 (or composite ≥ 65 but not tradeable)
- **AVOID** — composite < 50 OR risk > 60

---

## Classifier (Perplexity)

New prompt format, replacing the 3-lens dual-tier prompt. Returns JSON:

```typescript
interface UnifiedClassification {
  thesis: string;                 // 2-3 sentences, plain English
  valueCase: string;              // why mispriced? vs what?
  catalysts: Array<{              // 1-5 specific upcoming events
    description: string;
    date: string | null;          // YYYY-MM-DD if known
  }>;
  keyRisks: string[];             // 1-3
  expectedReturn30d: number;      // integer %
  convictionScore: number;        // 0-10
  recommendation: 'BUY' | 'WATCH' | 'AVOID';
}
```

Perplexity remains the right tool — real-time web search is essential for "is there news we don't know about yet".

---

## Trader changes

### Primary catalyst captured at entry (exactly one)

Priority order at BUY time, stored in `trades.entry_category`:

1. **`earnings_event`** — earnings within 10 days. `entry_catalyst_date = earnings_date`, `entry_catalyst_type = 'earnings_YYYY-MM-DD'`.
2. **`insider_signal`** — large insider buy (>$100k) in last 30 days. `entry_catalyst_date = most_recent_buy_date`, `entry_catalyst_type = 'insider_buy_YYYY-MM-DD'`.
3. **`value_rerating`** — value score ≥ 70 (regardless of catalyst score). `entry_catalyst_date = null`, `entry_catalyst_type = 'value_rerating'`.
4. **`attention_momentum`** — default fallback when none of the above match. `entry_catalyst_date = null`, `entry_catalyst_type = 'attention_momentum'`.

Evaluation short-circuits at the first matching category. A ticker with both a near earnings date AND a high value score is classified as `earnings_event` (the nearer-term catalyst wins).

Exactly one per position. Determined at BUY time from the scoring/enrichment data. Stored in `trades` and `portfolio_state`.

### Category-specific max holds

Defined as a const map in `trader.ts`, not in DB config (avoids config sprawl):

```typescript
const CATEGORY_MAX_HOLD_DAYS: Record<EntryCategory, number> = {
  earnings_event: 12,       // catalyst resolves + grace
  insider_signal: 30,       // insider theses resolve over weeks
  value_rerating: 45,       // rerating is slow
  attention_momentum: 7,    // should not linger
};
const DEFAULT_MAX_HOLD_DAYS = 35;
```

`evaluateSell` uses `CATEGORY_MAX_HOLD_DAYS[position.entry_category] ?? DEFAULT_MAX_HOLD_DAYS`.

### Category-specific fade rules

Also in `evaluateSell`:

- **`earnings_event`**: if `entry_catalyst_date` passed AND unrealized P&L < +3% → SELL within 2 subsequent runs.
- **`insider_signal`**: no fade (hold to max).
- **`value_rerating`**: no fade (hold to max unless stop-loss or AVOID reclass).
- **`attention_momentum`**: if unrealized P&L < +2% after 3 days → SELL.

### Position sizing (conservative first deployment)

| Parameter | Old (pre-unified) | New |
|---|---|---|
| Base position size | 7.5% (MOMENTUM) / 12.5% (QUALITY) | **10%** uniform |
| High conviction size | 15% | **14%** |
| `max_position_pct` | 16 | **15** |
| `max_portfolio_heat_pct` | 40 | **60** |
| Max positions at 5 × 10-14% | n/a | ~50-60% exposure |

High conviction defined in code as: `composite ≥ 80 AND risk ≤ 30 AND numAnalysts ≥ 5`.

Tier-based position sizing block (lines ~336-354 in current `trader.ts`) deleted.

### Updated `trading_config` row (SQL, reversible)

```sql
UPDATE trading_config SET
  max_position_pct = 15,
  max_portfolio_heat_pct = 60,
  min_fundamentals = 55,
  max_risk = 45,
  min_momentum = 20,
  hold_days_max = 35,
  quality_hold_days_max = 35,
  high_conviction_size_pct = 14,
  scan_miss_max = 6
WHERE id = 1;
```

### Attribution logging

Every BUY captures all component scores at entry time. Every SELL captures all component scores at exit time plus `exit_reason`. This enables weekly attribution analysis without which weight tuning is blind.

`exit_reason` enum values: `stop_loss`, `catalyst_fade`, `max_hold`, `reclass_avoid`, `scan_miss`, `manual`.

---

## Database changes (migration-009)

```sql
-- Attribution logging on trades
ALTER TABLE trades
  ADD COLUMN entry_value_score INT,
  ADD COLUMN entry_catalyst_score INT,
  ADD COLUMN entry_upside_score INT,
  ADD COLUMN entry_risk_score INT,
  ADD COLUMN entry_composite INT,
  ADD COLUMN entry_category TEXT,
  ADD COLUMN entry_catalyst_type TEXT,
  ADD COLUMN entry_catalyst_date DATE,
  ADD COLUMN exit_value_score INT,
  ADD COLUMN exit_catalyst_score INT,
  ADD COLUMN exit_upside_score INT,
  ADD COLUMN exit_risk_score INT,
  ADD COLUMN exit_composite INT,
  ADD COLUMN exit_reason TEXT;

-- Also add to portfolio_state so we can reference category when evaluating sells
ALTER TABLE portfolio_state
  ADD COLUMN entry_category TEXT,
  ADD COLUMN entry_catalyst_date DATE;

-- Tradeability metadata on scan_results
ALTER TABLE scan_results
  ADD COLUMN tradeable BOOLEAN DEFAULT false,
  ADD COLUMN gate_failures TEXT[];
```

No column drops. No renames. `tier` column kept. Historical rows remain intact.

---

## Code changes

### New files

- `backend/src/services/yahoo.ts` — `fetchQuoteSummary(ticker)`
- `backend/src/services/sectorMedians.ts` — static const map
- `backend/src/lib/tradeability.ts` — 6 hard-gate functions, returns `{ tradeable, failures }`
- `database/migration-009-unified-screener.sql`

### Substantial rewrites

- `backend/src/pipeline.ts` — delete `selectTickersWithDualTier`, `enrichTickersWithMarketDataTiered`, `applyUniverseFiltersTiered`, `validateQualityTickers`, `calculateTechnicalsForTickersTiered`. Replace with single-path equivalents.
- `backend/src/services/scoring.ts` — near-total rewrite. New functions: `calculateValueScore`, `calculateCatalystScore`, `calculateUpsideScore`, `calculateRiskScore`, `calculateCompositeScore`.
- `backend/src/services/classifier.ts` — new Perplexity prompt, new response schema.
- `backend/src/services/trader.ts` — category-aware holds, fade rules, entry attribution in `evaluateBuy`, exit attribution in `evaluateSell` + `reconcilePendingOrders`, deletion of tier-based sizing, primary-catalyst-at-entry determination.
- `backend/src/services/finviz.ts` — replace 4 penny queries with 6 new screener URLs. Drop hardcoded `<$10`.

### Small edits

- `backend/src/types/index.ts` — new types: `ComponentScores`, `EntryCategory`, `CatalystType`, `UnifiedClassification`.
- `backend/src/services/finnhub.ts` — wire `fetchInsiderTransactions` into `enrichForClassifier`.
- `backend/src/pipeline.ts` save site — write new attribution columns.

### Frontend (web-dashboard)

- `routes/+page.svelte` — remove tier badge column, add BUY/WATCH/AVOID badge, add tradeable indicator with hover tooltip listing failed gates, replace lens scores with component scores `V:28 C:32 U:22 R:12` and composite.
- `routes/ticker/[symbol]/+page.svelte` — thesis hero updated to show: `valueCase`, catalysts list with dates, `keyRisks`, `expectedReturn30d`, `convictionScore`.
- `routes/portfolio/+page.svelte` AI Trades tab — add columns for `entry_category`, `entry_catalyst_date`, and component score breakdown.
- `routes/analytics/+page.svelte` — retire "Tier Performance" and "Tier Over Time" tabs (in a follow-up commit, not this one). Add new **"Attribution"** tab: win rate + avg P&L by `entry_category`, scatter plot of `entry_composite` vs `pnl_pct`, bar chart per component-score bucket vs hit rate.
- `routes/+page.svelte` filter bar — remove tier filter, add `tradeable only` toggle and `category` filter.

---

## Rollout plan

### Phase 0 — Prep
1. Code written on a feature branch.
2. Migration 009 written but not executed.
3. Local pipeline dry-run against prod DB with `enabled=false`.
4. Manually inspect top 10 candidates: do they look like value+catalyst plays?
5. `tsc --noEmit` clean on backend and web-dashboard.

### Phase 1 — Deploy backend in dark mode
1. `UPDATE trading_config SET enabled=false WHERE id=1`.
2. Merge feature branch → Railway auto-deploys.
3. Run migration 009 manually.
4. Observe 2-3 cron runs. Verify scan_results are populated with new scoring, `tradeable` flag set correctly, `gate_failures` populated for failing rows.

### Phase 2 — Reset paper account
**Hard reset** Alpaca paper account via the Alpaca dashboard (one click). Starts fresh $100k, no prior positions. Cleanest attribution from day one.

### Phase 3 — Re-enable trading
1. `UPDATE trading_config SET enabled=true WHERE id=1`.
2. Monitor `trade_decisions` for SKIP reason distribution — expect a mix, not "everything fails gate X".
3. Monitor `trades` table for BUYs.

### Phase 4 — Observe (2 weeks, 10 trading days)
- No weight tuning. No gate changes. Let the system run.
- Collect attribution data via the new analytics tab.

### Phase 5 — First tuning pass
- Based on attribution, adjust weights / gates / categories.
- Track changes in a CHANGELOG-style memory file.

---

## Testing plan

### Before Phase 1
- `tsc --noEmit` clean across backend and web-dashboard.
- Local pipeline run with `enabled=false` hardcoded: no exceptions, scan_results rows written.
- Spot-check 10 random candidates: component breakdown sensible, Yahoo data present, sector medians applied.
- Hard gate spot-check: force a known sub-$2 stock, known ETF, known micro-cap — verify they fail the expected gates.
- Attribution spot-check: force-create a fake trade in a test run, verify all `entry_*` columns populated.

### During Phase 1 (dark mode)
- `SELECT classification, COUNT(*) FROM scan_results WHERE run_id IN (last 5) GROUP BY classification` — expect mix, not 0 BUYs.
- `SELECT tradeable, COUNT(*) FROM scan_results WHERE run_id = (latest) GROUP BY tradeable` — expect some true, some false.
- `SELECT gate_failures FROM scan_results WHERE tradeable = false LIMIT 20` — expect sensible distribution.

### During Phase 3 (live)
- First 24 hours: watch `trade_decisions` SKIP-reason distribution.
- First trade entry: manually verify entry attribution columns populated correctly.
- First trade exit: verify exit attribution columns populated correctly.

---

## Estimated effort

- Phase 0 (code + local verify): ~5-7 hours
- Phase 1 (deploy dark): ~15 min
- Phase 2 (Alpaca reset): ~5 min
- Phase 3 (re-enable): ~5 min
- Phase 4 (observe): 2 weeks wall clock, zero active work
- Phase 5 (first tune): 1-2 hours
