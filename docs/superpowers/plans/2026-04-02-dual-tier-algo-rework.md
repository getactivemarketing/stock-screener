# Dual-Tier Algorithm Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the screener from a single-tier penny stock hype detector into a dual-tier momentum + value system with Finnhub enrichment, tier-aware fundamentals scoring, and a three-lens classifier prompt.

**Architecture:** The pipeline keeps its existing 10-step structure. Key changes: Step 3 reworked for dynamic dual-tier candidate selection (MOMENTUM + QUALITY), new Step 6.5 for Finnhub classifier enrichment (analyst ratings, earnings, news), tier-aware fundamentals scoring in Step 7, and a completely new Perplexity prompt that evaluates through value/catalyst/emerging-industry lenses. Database gets new columns, trader gets tier-aware sizing.

**Tech Stack:** TypeScript, PostgreSQL, Finnhub API (existing key), Perplexity API (existing), Alpaca paper trading.

**Spec:** `docs/superpowers/specs/2026-04-02-dual-tier-algo-rework-design.md`

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `database/migration-008-dual-tier.sql` | New columns on scan_results, scan_runs, trading_config |

### Modified Files
| File | Changes |
|------|---------|
| `backend/src/types/index.ts` | Add `ClassifierEnrichment`, `Tier` type, update `TickerAnalysis` with tier + enrichment |
| `backend/src/services/finnhub.ts` | Add `enrichForClassifier()` — wraps existing endpoints into one call |
| `backend/src/services/scoring.ts` | Add `computeQualityFundamentals()`, sector median table, tier-aware `calculateFundamentalsScore()` |
| `backend/src/services/classifier.ts` | Replace prompt with dual-tier version, update output parsing |
| `backend/src/pipeline.ts` | Rework Step 3 (dynamic allocation), add Step 6.5 (enrichment), save new columns |
| `backend/src/services/trader.ts` | Tier-aware position sizing, quality hold period |
| `backend/src/services/backtest.ts` | Tier-aware simulation |

---

## Task 1: Database Migration — Dual-Tier Columns

**Files:**
- Create: `database/migration-008-dual-tier.sql`

- [ ] **Step 1: Write the migration**

Create `database/migration-008-dual-tier.sql`:

```sql
-- Migration 008: Dual-Tier Algorithm Support
-- Date: 2026-04-02

-- Tier and lens scores
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS tier VARCHAR(10);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS value_score SMALLINT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS catalyst_score SMALLINT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS emerging_industry_score SMALLINT;

-- Enriched classifier output
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS thesis TEXT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS edge_why_now TEXT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS industry_theme VARCHAR(100);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS stop_loss_pct DECIMAL(5,2);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS expected_returns JSONB;

-- Enrichment data (persisted for audit)
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS analyst_mean_target DECIMAL(10,2);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS analyst_summary TEXT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS earnings_date DATE;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS days_to_earnings INT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS earnings_beat_rate DECIMAL(5,2);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS news_headlines TEXT[];

-- Tier breakdown per run
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS momentum_count INT;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS quality_count INT;

-- Quality hold period
ALTER TABLE trading_config ADD COLUMN IF NOT EXISTS quality_hold_days_max INT DEFAULT 15;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scan_results_tier ON scan_results(tier);
CREATE INDEX IF NOT EXISTS idx_scan_results_industry_theme ON scan_results(industry_theme);
```

- [ ] **Step 2: Run the migration**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
cat > src/scripts/run-migration-008.ts << 'EOF'
import db from '../db/index.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

async function main() {
  const sql = readFileSync(resolve(process.cwd(), '../database/migration-008-dual-tier.sql'), 'utf-8');
  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('--'));
  for (const stmt of statements) {
    try {
      await db.query(stmt);
      console.log('OK:', stmt.substring(0, 60) + '...');
    } catch (e: any) {
      console.error('FAIL:', stmt.substring(0, 60), e.message);
    }
  }
  // Verify
  const cols = await db.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'scan_results' AND column_name IN ('tier','value_score','catalyst_score','emerging_industry_score','thesis','industry_theme')
    ORDER BY column_name
  `);
  console.log('\nNew columns:', cols.map((c: any) => c.column_name));
  await db.close();
}
main().catch(console.error);
EOF
npx tsx src/scripts/run-migration-008.ts
rm src/scripts/run-migration-008.ts
```

Expected: All ALTERs succeed. New columns listed.

- [ ] **Step 3: Commit**

```bash
git add database/migration-008-dual-tier.sql
git commit -m "feat: add dual-tier columns migration (tier, lens scores, enrichment data)"
```

---

## Task 2: Add Types for Dual-Tier System

**Files:**
- Modify: `backend/src/types/index.ts`

- [ ] **Step 1: Add new types**

Append after the existing `EnrichedClassificationResult` interface at the end of `types/index.ts`:

```typescript
// ── Dual-Tier Types ────────────────────────────────────

export type Tier = 'MOMENTUM' | 'QUALITY';

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
}

export interface DualTierClassificationResult {
  classification: Classification;
  tier: Tier;
  confidence: number;
  valueScore: number;        // 0-10
  catalystScore: number;     // 0-10
  emergingIndustryScore: number; // 0-10
  thesis: string;
  edgeWhyNow: string;
  bullCase: string;
  bearCase: string;
  keyRisk: string;
  catalysts: string[];
  industryTheme: string | null;
  tradeRationale: string;
  suggestedPositionPct: number;
  targetPrice: {
    target: number;
    reasoning: string;
    confidence: number;
  };
  stopLossPct: number;       // -10 to -20
  expectedReturns: {
    oneMonth: string;
    threeMonth: string;
    twelveMonth: string;
  };
}
```

- [ ] **Step 2: Update TickerAnalysis to include tier**

Find the `TickerAnalysis` interface (line ~90) and add `tier` and `enrichment`:

```typescript
export interface TickerAnalysis {
  ticker: string;
  runId: string;
  runTimestamp: Date;
  tier: Tier;                              // NEW
  sentiment: MergedSentiment;
  price: PriceData;
  fundamentals: FundamentalData;
  scores: Scores;
  classification: ClassificationResult;
  enrichment?: ClassifierEnrichment;       // NEW
  alertTriggered: boolean;
  alertType: 'runner' | 'value' | 'both' | 'pump_warning' | null;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsc --noEmit
```

There will be errors because existing code doesn't pass `tier` yet — that's expected. Just verify the new type definitions parse correctly (errors should be about missing `tier` property in pipeline.ts, not syntax errors in types).

- [ ] **Step 4: Commit**

```bash
git add backend/src/types/index.ts
git commit -m "feat: add Tier, ClassifierEnrichment, DualTierClassificationResult types"
```

---

## Task 3: Finnhub Classifier Enrichment

**Files:**
- Modify: `backend/src/services/finnhub.ts`

The file already has `fetchRecommendations()`, `fetchEarningsCalendar()`, and `fetchNews()`. We need a new function that wraps all three plus a price target call.

- [ ] **Step 1: Add fetchPriceTarget function**

Add before the `export default` block in `finnhub.ts`:

```typescript
interface FinnhubPriceTarget {
  lastUpdated: string;
  symbol: string;
  targetHigh: number;
  targetLow: number;
  targetMean: number;
  targetMedian: number;
}

export async function fetchPriceTarget(ticker: string): Promise<FinnhubPriceTarget | null> {
  try {
    const url = `${BASE_URL}/stock/price-target?symbol=${ticker}&token=${config.finnhubApiKey}`;
    const data = await fetchWithRetry<FinnhubPriceTarget>(url, {}, rateLimiters.finnhub);
    return data?.targetMean ? data : null;
  } catch (error) {
    console.error(`Finnhub price target failed for ${ticker}:`, error);
    return null;
  }
}
```

- [ ] **Step 2: Add enrichForClassifier function**

Add after `fetchPriceTarget`:

```typescript
import type { ClassifierEnrichment } from '../types/index.js';

/**
 * Fetch all classifier enrichment data for a ticker in parallel.
 * Returns analyst ratings, earnings info, and news headlines.
 * Any individual call can fail without failing the whole enrichment.
 */
export async function enrichForClassifier(
  ticker: string,
  existingHeadlines?: string[]
): Promise<ClassifierEnrichment> {
  const [recommendations, priceTarget, earnings, news] = await Promise.all([
    fetchRecommendations(ticker).catch(() => null),
    fetchPriceTarget(ticker).catch(() => null),
    fetchEarningsCalendar(ticker).catch(() => []),
    existingHeadlines && existingHeadlines.length > 0
      ? Promise.resolve(existingHeadlines)
      : fetchNews(ticker).then(articles => articles.slice(0, 5).map(a => a.headline)).catch(() => []),
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
  if (earnings.length > 0) {
    // Find next upcoming earnings (future dates)
    const now = new Date();
    const upcoming = earnings.find(e => new Date(e.date) >= now);

    // Calculate beat rate from historical data (last 4 quarters with actual data)
    const historical = earnings
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
  const newsHeadlines = (Array.isArray(news) && news.length > 0) ? news.slice(0, 5) : null;

  return { analystRatings, earnings: earningsInfo, newsHeadlines };
}
```

Note: Update the import at the top of the file to include `ClassifierEnrichment`:
```typescript
import type { FinnhubQuote, FinnhubProfile, FundamentalData, PriceData, ClassifierEnrichment } from '../types/index.js';
```

- [ ] **Step 3: Add to default export**

Add `fetchPriceTarget` and `enrichForClassifier` to the `export default` object.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/finnhub.ts
git commit -m "feat: add enrichForClassifier() — analyst ratings, earnings, news in one call"
```

---

## Task 4: Tier-Aware Fundamentals Scoring

**Files:**
- Modify: `backend/src/services/scoring.ts`

- [ ] **Step 1: Add sector median table and QUALITY fundamentals function**

Add before the existing `calculateFundamentalsScore` function (before line 85):

```typescript
import type { ClassifierEnrichment, Tier } from '../types/index.js';

// Sector forward P/E medians (hardcoded v1)
const SECTOR_PE_MEDIANS: Record<string, number> = {
  'Technology': 28,
  'Biotech': 35,
  'Life Sciences': 35,
  'Biotechnology': 35,
  'Energy': 12,
  'Industrials': 18,
  'Healthcare': 22,
  'Financials': 14,
  'Financial Services': 14,
  'Consumer Discretionary': 22,
  'Consumer Cyclical': 22,
  'Consumer Staples': 20,
  'Consumer Defensive': 20,
  'Utilities': 16,
  'Real Estate': 18,
  'Materials': 15,
  'Basic Materials': 15,
  'Communication Services': 20,
};
const DEFAULT_PE_MEDIAN = 20;

function getSectorMedianPE(sector: string): number {
  // Try exact match first, then partial match
  if (SECTOR_PE_MEDIANS[sector]) return SECTOR_PE_MEDIANS[sector];
  const key = Object.keys(SECTOR_PE_MEDIANS).find(k =>
    sector.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(sector.toLowerCase())
  );
  return key ? SECTOR_PE_MEDIANS[key] : DEFAULT_PE_MEDIAN;
}

/**
 * QUALITY tier fundamentals score (0-100)
 * Weighted: 30% analyst target distance, 30% relative P/E, 20% earnings beat rate, 20% margins/debt
 */
function computeQualityFundamentals(
  price: number,
  fundamentals: FundamentalData,
  enrichment?: ClassifierEnrichment
): number {
  let score = 0;

  // 1. Price-to-analyst-target distance (0-30 points)
  const meanTarget = enrichment?.analystRatings?.meanTarget;
  if (meanTarget && meanTarget > 0 && price > 0) {
    const impliedUpside = (meanTarget - price) / price;
    // 25%+ upside = 30 pts, linear scale down to 0% = 0 pts
    score += Math.round(Math.max(0, Math.min(30, (impliedUpside / 0.25) * 30)));
  }

  // 2. Forward P/E vs sector median (0-30 points)
  if (fundamentals.peRatio !== null && fundamentals.peRatio > 0) {
    const sectorMedian = getSectorMedianPE(fundamentals.sector || '');
    const ratio = fundamentals.peRatio / sectorMedian;
    // At 70% of median = 30 pts, at 100% = 15 pts, at 130%+ = 0 pts
    if (ratio <= 0.7) {
      score += 30;
    } else if (ratio <= 1.3) {
      score += Math.round(30 - ((ratio - 0.7) / 0.6) * 30);
    }
    // ratio > 1.3 = 0 points
  }

  // 3. Earnings beat rate (0-20 points)
  const beatRate = enrichment?.earnings?.earningsBeatRate;
  if (beatRate !== null && beatRate !== undefined) {
    score += Math.round((beatRate / 100) * 20);
  } else {
    score += 10; // Neutral when no data
  }

  // 4. Existing checks scaled to 20 points (0-20)
  let legacyScore = 0;
  // Margins
  if (fundamentals.grossMargin !== null) {
    if (fundamentals.grossMargin > 50) legacyScore += 4;
    else if (fundamentals.grossMargin > 30) legacyScore += 2;
  }
  if (fundamentals.operatingMargin !== null) {
    if (fundamentals.operatingMargin > 20) legacyScore += 4;
    else if (fundamentals.operatingMargin > 0) legacyScore += 2;
    else legacyScore -= 2;
  }
  // Debt
  if (fundamentals.debtEquity !== null) {
    if (fundamentals.debtEquity < 0.3) legacyScore += 4;
    else if (fundamentals.debtEquity > 2) legacyScore -= 4;
    else if (fundamentals.debtEquity > 1) legacyScore -= 2;
  }
  // Revenue growth
  if (fundamentals.revenueGrowth !== null) {
    if (fundamentals.revenueGrowth > 50) legacyScore += 6;
    else if (fundamentals.revenueGrowth > 20) legacyScore += 4;
    else if (fundamentals.revenueGrowth > 0) legacyScore += 2;
    else if (fundamentals.revenueGrowth < -20) legacyScore -= 4;
  }
  // Exchange bonus
  if (['NYSE', 'NASDAQ'].some(e => fundamentals.exchange?.includes(e))) {
    legacyScore += 2;
  }
  score += Math.max(0, Math.min(20, legacyScore + 10)); // Shift so 0 legacy = 10 pts (neutral)

  return Math.round(Math.max(0, Math.min(100, score)));
}
```

- [ ] **Step 2: Update calculateFundamentalsScore to be tier-aware**

Rename the existing `calculateFundamentalsScore` to `computeMomentumFundamentals` (keep the body identical). Then create a new `calculateFundamentalsScore` that dispatches:

```typescript
/**
 * Original penny stock fundamentals formula (unchanged)
 */
function computeMomentumFundamentals(fundamentals: FundamentalData): number {
  // ... existing body of calculateFundamentalsScore, unchanged ...
}

/**
 * Calculate fundamentals score (0-100) — tier-aware
 */
export function calculateFundamentalsScore(
  fundamentals: FundamentalData,
  tier?: Tier,
  price?: number,
  enrichment?: ClassifierEnrichment
): number {
  if (tier === 'QUALITY' && price) {
    return computeQualityFundamentals(price, fundamentals, enrichment);
  }
  return computeMomentumFundamentals(fundamentals);
}
```

- [ ] **Step 3: Update calculateAllScores to accept tier + enrichment**

```typescript
export function calculateAllScores(
  sentiment: MergedSentiment,
  price: PriceData,
  fundamentals: FundamentalData,
  tier?: Tier,
  enrichment?: ClassifierEnrichment
): Scores {
  const attention = calculateAttentionScore(sentiment);
  const momentum = calculateMomentumScore(price);
  const fundamentalsScore = calculateFundamentalsScore(fundamentals, tier, price.price, enrichment);
  const risk = calculateRiskScore(sentiment, price, fundamentals, attention, fundamentalsScore);

  return {
    attention,
    momentum,
    fundamentals: fundamentalsScore,
    risk,
  };
}
```

- [ ] **Step 4: Update the import at the top of the file**

Add `ClassifierEnrichment` and `Tier` to the import from `../types/index.js`.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/scoring.ts
git commit -m "feat: add tier-aware fundamentals scoring with QUALITY formula"
```

---

## Task 5: Replace Classifier Prompt

**Files:**
- Modify: `backend/src/services/classifier.ts`

This is the biggest single change. The entire `buildPrompt()` function and `parseResponse()` function get rewritten.

- [ ] **Step 1: Update the AnalysisWithTarget interface**

Replace the existing `AnalysisWithTarget` with `DualTierClassificationResult` import:

```typescript
import type {
  Scores,
  MergedSentiment,
  PriceData,
  FundamentalData,
  ClassificationResult,
  Classification,
  ClassifierEnrichment,
  Tier,
  DualTierClassificationResult,
} from '../types/index.js';

export type { DualTierClassificationResult as AnalysisWithTarget };
```

- [ ] **Step 2: Update the TickerContext interface**

```typescript
interface TickerContext {
  ticker: string;
  tier: Tier;
  scores: Scores;
  sentiment: MergedSentiment;
  price: PriceData;
  fundamentals: FundamentalData;
  enrichment?: ClassifierEnrichment;
  preliminaryClassification: Classification;
}
```

- [ ] **Step 3: Replace buildPrompt()**

Replace the entire `buildPrompt()` function with the new dual-tier prompt. This is the prompt the user provided, with template variables filled from `TickerContext`:

```typescript
function buildPrompt(context: TickerContext): string {
  const { ticker, tier, scores, sentiment, price, fundamentals, enrichment, preliminaryClassification } = context;

  // Format analyst ratings
  const analystRatings = enrichment?.analystRatings
    ? `${enrichment.analystRatings.summary}${enrichment.analystRatings.meanTarget ? ` | Mean target: $${enrichment.analystRatings.meanTarget.toFixed(2)}` : ''}`
    : 'No analyst coverage';

  // Format earnings
  const earningsDate = enrichment?.earnings?.nextDate || 'Unknown';
  const daysToEarnings = enrichment?.earnings?.daysToEarnings !== null ? `${enrichment.earnings!.daysToEarnings}` : 'Unknown';

  // Format news
  const headlines = enrichment?.newsHeadlines?.length
    ? enrichment.newsHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : 'No recent news';

  return `You are a professional equity analyst evaluating stocks for an automated momentum + value trading strategy. You have been given a stock with the following pre-computed data:

TICKER: ${ticker}
COMPANY: ${fundamentals.name || 'Unknown'}
SECTOR: ${fundamentals.sector || 'Unknown'}
PRICE: $${price.price.toFixed(2)} | CHANGE: ${price.change1dPercent.toFixed(2)}%
MARKET CAP: $${formatMarketCap(fundamentals.marketCap)}
AVG DAILY VOLUME: ${Math.round(price.avgVolume30d).toLocaleString()}
TIER: ${tier}
ATTENTION SCORE: ${scores.attention}/100
MOMENTUM SCORE: ${scores.momentum}/100
FUNDAMENTALS SCORE: ${scores.fundamentals}/100
RISK SCORE: ${scores.risk}/100 (lower = safer)
RSI: ${context.price.change1dPercent > 0 ? 'N/A' : 'N/A'} | MACD: N/A | Volume vs Avg: ${price.relativeVolume.toFixed(2)}x
ANALYST RATINGS: ${analystRatings}
UPCOMING EARNINGS: ${earningsDate} (${daysToEarnings} days away)
RECENT NEWS HEADLINES:
${headlines}

---

TIER CONTEXT — read this before evaluating:

If TIER = "MOMENTUM":
This is a retail-driven penny stock under $20. The edge here is social sentiment + short-term price momentum.
Prioritize: attention velocity (mentions accelerating), relative volume spikes, technical breakout setups,
short squeeze potential, and imminent catalysts (earnings, FDA, PR).
Fundamentals matter less — focus on whether the attention is building toward a move.
Typical hold: 1-5 days. Target return: 10-30%.

If TIER = "QUALITY":
This is a mid-cap stock with real liquidity and institutional coverage. The edge here is mispricing + catalysts
that the market hasn't fully priced in.
Prioritize: undervaluation vs. sector peers (forward P/E, P/S, EV/EBITDA), upcoming earnings with
beatable consensus estimates, emerging industry tailwinds (AI infrastructure, defense, energy transition,
biotech pipeline, GLP-1/obesity, US reshoring), and technical entry points (pullback from highs, RSI reset).
Fundamentals matter a lot — look for a quality business at a reasonable price with a near-term catalyst.
Typical hold: 3-20 days. Target return: 8-25%.

---

Evaluate this stock across THREE lenses:

LENS 1 — VALUE: Is this stock undervalued relative to its fundamentals or peers?
- MOMENTUM tier: Is the price compressed/beaten-down relative to recent range? Low float + high short interest?
- QUALITY tier: Forward P/E below sector median? Price-to-book below 1.5? Revenue growth not yet in price?
  Trading below analyst consensus target?

LENS 2 — CATALYST: Is there an imminent price catalyst within 1-30 days?
Look for: earnings (especially if beatable or with guidance revision potential), FDA decisions, contract
wins, partnerships, product launches, index inclusion, analyst upgrades, short squeeze setup, or major
macro event that directly benefits this company.

LENS 3 — EMERGING INDUSTRY: Is this company operating in a high-growth secular trend?
Look for: AI infrastructure (power, chips, data centers), energy transition (nuclear, solar, grid storage),
defense/aerospace ramp, biotech pipeline, quantum computing, robotics/automation, US reshoring/manufacturing,
GLP-1/obesity drugs, cybersecurity. A company riding a secular tailwind has a higher floor on any pullback.

---

Score each lens 0-10, produce your classification and trading plan, and respond ONLY in this exact JSON format:

{
  "classification": "runner" | "value" | "both" | "watch" | "avoid",
  "tier": "${tier}",
  "confidence": 0.0-1.0,
  "value_score": 0-10,
  "catalyst_score": 0-10,
  "emerging_industry_score": 0-10,
  "thesis": "2-3 sentences. For MOMENTUM stocks: focus on attention setup and technical trigger. For QUALITY stocks: cite specific valuation metrics, the mispricing, and what unlocks it. Always include at least one real number.",
  "edge_why_now": "1-2 sentences on why THIS WEEK is the right time.",
  "bull_case": "Best-case outcome and what drives it (1-2 sentences).",
  "bear_case": "What invalidates the thesis (1 sentence).",
  "key_risk": "The single most important risk to monitor.",
  "catalysts": ["list", "of", "specific", "upcoming", "catalysts"],
  "industry_theme": "Name the macro trend or null.",
  "trade_rationale": "One punchy sentence a trader would say out loud.",
  "suggested_position_pct": 5-15,
  "target_price": {
    "target": 0.00,
    "reasoning": "Brief target reasoning.",
    "confidence": 0.0-1.0
  },
  "stop_loss_pct": -10 to -20,
  "expected_returns": {
    "1m": "+X%",
    "3m": "+X%",
    "12m": "+X%"
  }
}

CLASSIFICATION RULES:
- "runner": Strong momentum + imminent catalyst OR accelerating retail attention. Primarily for MOMENTUM tier.
- "value": Fundamentally undervalued with a near-term catalyst to unlock it. Primarily for QUALITY tier.
- "both": Meets runner AND value criteria. Rare — highest conviction across both tiers.
- "watch": Interesting but missing one key ingredient. Set an alert, don't act yet.
- "avoid": No clear edge in any lens, or risk score too high with no offsetting thesis.

POSITION SIZING GUIDANCE:
- MOMENTUM tier: default 5-10% (higher volatility, shorter hold, smaller size)
- QUALITY tier: default 10-15% (higher conviction, longer hold, larger size justified)
- High conviction (all lens scores >= 7, risk score < 30): can go to 15%

Do not hallucinate financials. If data for a lens is missing or uncertain, score it 0 and reduce confidence accordingly.`;
}
```

- [ ] **Step 4: Replace parseResponse()**

Replace the entire `parseResponse()` function:

```typescript
function parseResponse(
  response: string,
  fallbackClassification: Classification,
  currentPrice: number,
  tier: Tier
): DualTierClassificationResult {
  try {
    let jsonStr = response.trim();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const p = JSON.parse(jsonStr);

    return {
      classification: validateClassification(p.classification) || fallbackClassification,
      tier,
      confidence: typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0.5,
      valueScore: typeof p.value_score === 'number' ? Math.max(0, Math.min(10, Math.round(p.value_score))) : 0,
      catalystScore: typeof p.catalyst_score === 'number' ? Math.max(0, Math.min(10, Math.round(p.catalyst_score))) : 0,
      emergingIndustryScore: typeof p.emerging_industry_score === 'number' ? Math.max(0, Math.min(10, Math.round(p.emerging_industry_score))) : 0,
      thesis: typeof p.thesis === 'string' ? p.thesis : 'Analysis unavailable',
      edgeWhyNow: typeof p.edge_why_now === 'string' ? p.edge_why_now : '',
      bullCase: typeof p.bull_case === 'string' ? p.bull_case : 'Analysis unavailable',
      bearCase: typeof p.bear_case === 'string' ? p.bear_case : 'Analysis unavailable',
      keyRisk: typeof p.key_risk === 'string' ? p.key_risk : '',
      catalysts: Array.isArray(p.catalysts) ? p.catalysts.filter((c: unknown) => typeof c === 'string') : [],
      industryTheme: typeof p.industry_theme === 'string' ? p.industry_theme : null,
      tradeRationale: typeof p.trade_rationale === 'string' ? p.trade_rationale : '',
      suggestedPositionPct: typeof p.suggested_position_pct === 'number' ? Math.max(0, Math.min(15, p.suggested_position_pct)) : (tier === 'QUALITY' ? 10 : 5),
      targetPrice: {
        target: p.target_price?.target && typeof p.target_price.target === 'number'
          ? Math.round(p.target_price.target * 100) / 100
          : Math.round(currentPrice * 1.15 * 100) / 100,
        reasoning: typeof p.target_price?.reasoning === 'string' ? p.target_price.reasoning : 'Default target',
        confidence: typeof p.target_price?.confidence === 'number' ? Math.max(0, Math.min(1, p.target_price.confidence)) : 0.4,
      },
      stopLossPct: typeof p.stop_loss_pct === 'number' ? Math.max(-30, Math.min(-5, p.stop_loss_pct)) : (tier === 'QUALITY' ? -12 : -15),
      expectedReturns: {
        oneMonth: typeof p.expected_returns?.['1m'] === 'string' ? p.expected_returns['1m'] : 'N/A',
        threeMonth: typeof p.expected_returns?.['3m'] === 'string' ? p.expected_returns['3m'] : 'N/A',
        twelveMonth: typeof p.expected_returns?.['12m'] === 'string' ? p.expected_returns['12m'] : 'N/A',
      },
    };
  } catch (error) {
    console.error('Failed to parse Perplexity response:', error);
    return {
      classification: fallbackClassification,
      tier,
      confidence: 0.3,
      valueScore: 0,
      catalystScore: 0,
      emergingIndustryScore: 0,
      thesis: 'Analysis parsing failed',
      edgeWhyNow: '',
      bullCase: 'Analysis unavailable',
      bearCase: 'Analysis unavailable',
      keyRisk: '',
      catalysts: [],
      industryTheme: null,
      tradeRationale: '',
      suggestedPositionPct: 5,
      targetPrice: {
        target: Math.round(currentPrice * 1.15 * 100) / 100,
        reasoning: 'Default target (analysis failed)',
        confidence: 0.2,
      },
      stopLossPct: -15,
      expectedReturns: { oneMonth: 'N/A', threeMonth: 'N/A', twelveMonth: 'N/A' },
    };
  }
}
```

- [ ] **Step 5: Update generateAnalysis() signature**

Update the `generateAnalysis` function to accept `tier` and `enrichment`, and return `DualTierClassificationResult`:

```typescript
export async function generateAnalysis(context: TickerContext): Promise<DualTierClassificationResult> {
  const prompt = buildPrompt(context);

  try {
    const response = await perplexity.chat.completions.create({
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'You are a professional equity analyst. Respond only with valid JSON, no markdown or explanation.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1500,
      temperature: 0.2,
    });

    const responseText = response.choices[0]?.message?.content || '';
    return parseResponse(responseText, context.preliminaryClassification, context.price.price, context.tier);
  } catch (error) {
    console.error(`Perplexity analysis failed for ${context.ticker}:`, error);
    return parseResponse('{}', context.preliminaryClassification, context.price.price, context.tier);
  }
}
```

Note: Increase `max_tokens` from 1024 to 1500 to accommodate the richer output format.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

There will be downstream errors in pipeline.ts since it references the old output format. That's fine — we fix pipeline.ts in the next task.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/classifier.ts
git commit -m "feat: replace classifier with dual-tier three-lens prompt"
```

---

## Task 6: Rework Pipeline — Dynamic Tier Selection + Enrichment + Save

**Files:**
- Modify: `backend/src/pipeline.ts`

This is the largest single file change. Three parts: Step 3 rework, Step 6.5 addition, and saveResults update.

- [ ] **Step 1: Add imports**

Add to the existing imports at the top of pipeline.ts:

```typescript
import { enrichForClassifier } from './services/finnhub.js';
import type { Tier, ClassifierEnrichment, DualTierClassificationResult } from './types/index.js';
```

- [ ] **Step 2: Replace selectTickersWithPennyPriority()**

Replace the entire `selectTickersWithPennyPriority` function (lines 259-299) with the new dual-tier dynamic selection:

```typescript
interface TierCandidate {
  ticker: string;
  tier: Tier;
  sentiment: MergedSentiment;
  rankScore: number;
}

function selectTickersWithDualTier(
  merged: Record<string, MergedSentiment>,
  enrichedData: Map<string, { price: PriceData; fundamentals: FundamentalData }> | null
): TierCandidate[] {
  const HARD_CAP = 40;
  const MOMENTUM_CAP = 25;
  const QUALITY_CAP = 25;
  const MOMENTUM_FLOOR = 10;
  const QUALITY_FLOOR = 5;
  const MOMENTUM_ATTENTION_MIN = 40;
  const QUALITY_FUNDAMENTALS_MIN = 50;

  const allTickers = Object.entries(merged);

  // Classify and rank
  const momentumCandidates: TierCandidate[] = [];
  const qualityCandidates: TierCandidate[] = [];

  for (const [ticker, sentiment] of allTickers) {
    // For initial selection, we use isPennyStock as proxy for MOMENTUM
    // QUALITY tier requires enrichment data (price, cap, volume) which we may not have yet
    // So we classify based on available info:
    const attentionScore = scoring.calculateAttentionScore(sentiment);

    if (sentiment.isPennyStock) {
      if (attentionScore >= MOMENTUM_ATTENTION_MIN) {
        momentumCandidates.push({ ticker, tier: 'MOMENTUM', sentiment, rankScore: attentionScore });
      }
    } else {
      // Non-penny stocks are QUALITY candidates — we'll validate price/cap/volume after enrichment
      // For now, rank by total mentions + sentiment as proxy
      const compositeScore = (sentiment.totalMentions * 0.3) + ((sentiment.avgSentiment + 100) * 0.3);
      qualityCandidates.push({ ticker, tier: 'QUALITY', sentiment, rankScore: compositeScore });
    }
  }

  // Sort by rank score descending
  momentumCandidates.sort((a, b) => b.rankScore - a.rankScore);
  qualityCandidates.sort((a, b) => b.rankScore - a.rankScore);

  // Dynamic allocation with soft floors
  let momentum = momentumCandidates.slice(0, MOMENTUM_CAP);
  let quality = qualityCandidates.slice(0, QUALITY_CAP);

  // Enforce soft floors — fill from other tier if needed
  if (momentum.length < MOMENTUM_FLOOR && quality.length > QUALITY_FLOOR) {
    const extraNeeded = MOMENTUM_FLOOR - momentum.length;
    const extra = quality.splice(QUALITY_FLOOR, extraNeeded);
    // Re-tag as MOMENTUM (they'll be evaluated as such)
    momentum.push(...extra.map(c => ({ ...c, tier: 'MOMENTUM' as Tier })));
  }
  if (quality.length < QUALITY_FLOOR && momentum.length > MOMENTUM_FLOOR) {
    const extraNeeded = QUALITY_FLOOR - quality.length;
    const extra = momentum.splice(MOMENTUM_FLOOR, extraNeeded);
    quality.push(...extra.map(c => ({ ...c, tier: 'QUALITY' as Tier })));
  }

  const combined = [...momentum, ...quality].slice(0, HARD_CAP);
  console.log(`  Selected ${momentum.length} MOMENTUM + ${quality.length} QUALITY = ${combined.length} tickers`);

  return combined;
}
```

- [ ] **Step 3: Update the main pipeline flow**

In `runPipeline()`, replace the ticker selection (around line 50-53) to use the new function. Then add Step 6.5 for enrichment, and pass `tier` through the pipeline.

The key changes are in the `scoreAndClassify` function — it needs to accept tier and enrichment per ticker. And `saveResults` needs to write the new columns.

Since this is a large refactor of the core pipeline, the implementer should:
1. Update `selectTickersWithPennyPriority` call → `selectTickersWithDualTier` call
2. Thread `tier` through `enrichTickersWithMarketData` (or assign tier after enrichment when we have price/cap data)
3. After Step 6 (technicals), add Step 6.5: loop through tickers and call `enrichForClassifier()` for each
4. Pass `tier` + `enrichment` into `scoreAndClassify` → `calculateAllScores` → `generateAnalysis`
5. Update `saveResults` to include the new columns

- [ ] **Step 4: Update saveResults to include new columns**

Add these columns to the INSERT statement and their values:

```
tier, value_score, catalyst_score, emerging_industry_score,
thesis, edge_why_now, industry_theme, stop_loss_pct, expected_returns,
analyst_mean_target, analyst_summary, earnings_date, days_to_earnings,
earnings_beat_rate, news_headlines
```

The values come from the `DualTierClassificationResult` and `ClassifierEnrichment` on each analysis.

- [ ] **Step 5: Update updateRunRecord to log tier breakdown**

After computing `alertCount`, also count tiers:

```typescript
const momentumCount = analyzedTickers.filter(t => t.tier === 'MOMENTUM').length;
const qualityCount = analyzedTickers.filter(t => t.tier === 'QUALITY').length;
```

And update the `scan_runs` UPDATE to include `momentum_count` and `quality_count`.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/pipeline.ts
git commit -m "feat: rework pipeline for dual-tier selection, enrichment, and new classifier"
```

---

## Task 7: Update Trader for Tier-Aware Sizing

**Files:**
- Modify: `backend/src/services/trader.ts`

- [ ] **Step 1: Update evaluateBuy for tier-aware position sizing**

In the `evaluateBuy` function, replace the position sizing block with:

```typescript
  // Position sizing by tier
  const tier = result.tier;
  const dualClassification = result.classification as any as DualTierClassificationResult;
  const valueScore = dualClassification?.valueScore ?? 0;
  const catalystScore = dualClassification?.catalystScore ?? 0;
  const emergingScore = dualClassification?.emergingIndustryScore ?? 0;

  const isHighConviction = valueScore >= 7 && catalystScore >= 7 && emergingScore >= 7 && scores.risk < 30;

  let sizePct: number;
  if (isHighConviction) {
    sizePct = 15;
  } else if (tier === 'QUALITY') {
    sizePct = 12.5; // midpoint of 10-15%
  } else {
    sizePct = 7.5; // midpoint of 5-10%
  }
```

- [ ] **Step 2: Update evaluateSell for quality hold period**

In `evaluateSell`, load `quality_hold_days_max` from config and use it for QUALITY tier:

```typescript
  // Use tier-appropriate hold period
  const maxHoldDays = (analysis?.tier === 'QUALITY')
    ? (config as any).qualityHoldDaysMax ?? 15
    : config.holdDaysMax;

  if (daysHeld >= maxHoldDays) {
    // ... existing sell logic
  }
```

Also add `qualityHoldDaysMax` to the `TradingConfig` interface in `types/index.ts` and to `loadTradingConfig()`.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/trader.ts backend/src/types/index.ts
git commit -m "feat: tier-aware position sizing and quality hold period in trader"
```

---

## Task 8: Update Backtest Simulation

**Files:**
- Modify: `backend/src/services/backtest.ts`

- [ ] **Step 1: Add tier-aware sizing to simulateTrading**

In the BUY evaluation section, after the score filters, add tier-aware position sizing:

```typescript
      // Determine tier from price
      const price = parseFloat(scan.price);
      const tier = price < 20 ? 'MOMENTUM' : 'QUALITY';
      const positionPct = tier === 'QUALITY' ? 12.5 : maxPositionPct;
      const positionValue = portfolioValue * (positionPct / 100);
```

Replace the existing `const positionValue = portfolioValue * (maxPositionPct / 100);` line.

- [ ] **Step 2: Add tier-aware hold period**

In the SELL evaluation section, use tier-appropriate hold period:

```typescript
      const maxHold = (pos.entryPrice >= 20) ? 15 : holdDaysMax; // QUALITY holds longer
      // ...
      } else if (pos.daysOpen >= maxHold) {
        sellReason = 'max-hold';
      }
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/backtest.ts
git commit -m "feat: tier-aware sizing and hold period in backtest simulation"
```

---

## Task 9: End-to-End Verification

**Files:** No new files — verification only.

- [ ] **Step 1: Full TypeScript build**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsc --noEmit
```

Expected: Clean, no errors.

- [ ] **Step 2: Verify new database columns exist**

```bash
npx tsx -e "... query information_schema for new columns ..."
```

- [ ] **Step 3: Dry-run the pipeline**

```bash
npx tsx src/pipeline.ts
```

Expected: Pipeline runs with new Step 6.5 enrichment. Should see MOMENTUM and QUALITY counts in the output. Trading disabled in config.

- [ ] **Step 4: Run backtest simulation**

```bash
npx tsx -e "import { simulateTrading } from './src/services/backtest.js'; ..."
```

Compare results against the pre-rework simulation to see if the QUALITY tier + longer holds improve returns.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve issues from dual-tier end-to-end verification"
```
