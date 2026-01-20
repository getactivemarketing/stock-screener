# Stock Screener Implementation Plan
## Value Stocks + Short-Run Momentum Scanner

---

## 1. Project Overview

### Goal
Build an automated stock screening system that identifies:
1. **Short-run runners**: High-volume, sentiment-driven penny stocks likely to make sharp moves (1-5 days)
2. **Good-value setups**: Small caps with improving fundamentals + catalyst/attention spike

### Output
Each screened ticker receives:
- **Scores** (0-100) across 4 axes: Attention, Momentum, Fundamentals, Risk
- **Classification**: `runner` | `value` | `both` | `avoid`
- **Narrative**: Bull/bear case, key catalysts, confidence level

### Constraints
- **Universe**: US-listed + OTC stocks, price <= $10
- **Schedule**: Hourly during market hours
- **Historical storage**: All runs persisted for backtesting

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CRON TRIGGER (Hourly)                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         LAYER 1: DATA COLLECTION                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   Swaggy     │  │  ApeWisdom   │  │   AltIndex   │  │ Reddit (v1)  │    │
│  │  Stocks API  │  │     API      │  │     API      │  │   Backup     │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                       │                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                      │
│  │ Alpha Vantage│  │   Finnhub    │  │  SEC EDGAR   │                      │
│  │  (Price/Vol) │  │ (Fundamentals│  │  (Filings)   │                      │
│  └──────────────┘  └──────────────┘  └──────────────┘                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      LAYER 2: NORMALIZATION & FILTERING                     │
│  • Normalize sentiment data to common schema                                │
│  • Filter: US/OTC only, price <= $10, drop mega-caps & ETFs                │
│  • Merge multi-source data by ticker                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       LAYER 3: FEATURE ENGINEERING                          │
│  • attention_score (0-100)                                                  │
│  • momentum_score (0-100)                                                   │
│  • fundamentals_score (0-100)                                               │
│  • risk_score (0-100) - pump/dump probability                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      LAYER 4: CLASSIFICATION (Claude)                       │
│  • Input: scores + raw metrics                                              │
│  • Output: classification, confidence, bull/bear case, catalysts           │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        LAYER 5: ALERTS & STORAGE                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │Runner Alert │  │ Value Alert │  │ Pump Warning│  │  Database   │        │
│  │(Email/Slack)│  │(Email/Slack)│  │   (Flag)    │  │  (History)  │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          LAYER 6: WEB DASHBOARD                             │
│  • Current screener results                                                 │
│  • Historical performance / backtest analysis                               │
│  • Ticker drill-down with charts                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Sources & APIs

### 3.1 Sentiment/Attention Data (Primary)

| Provider | Endpoint | Data Points | Rate Limits |
|----------|----------|-------------|-------------|
| **SwaggyStocks** | `api.swaggystock.com/v1/wsb/sentiment` | mentions, bullish_count, bearish_count, net_sentiment, momentum | ~100 req/day free |
| **ApeWisdom** | `apewisdom.io/api/v1.0/filter/all-stocks` | ticker, mentions, rank, upvotes | Public API, generous |
| **AltIndex** | `altindex.com/api` | reddit_sentiment, social_volume, alt_score | Requires subscription |

### 3.2 Price & Volume Data

| Provider | Endpoint | Data Points |
|----------|----------|-------------|
| **Alpha Vantage** | `TIME_SERIES_DAILY` | open, high, low, close, volume (daily) |
| **Alpha Vantage** | `TIME_SERIES_INTRADAY` | 5min/15min bars for intraday moves |
| **Finnhub** | `/quote` | current price, change, volume |
| **Finnhub** | `/stock/candle` | historical OHLCV |

### 3.3 Fundamental Data

| Provider | Endpoint | Data Points |
|----------|----------|-------------|
| **Alpha Vantage** | `OVERVIEW` | market_cap, P/E, P/S, EPS, sector, industry, country, exchange |
| **Finnhub** | `/stock/profile2` | market_cap, shares_outstanding, country, exchange |
| **Finnhub** | `/stock/metric` | P/E, P/B, revenue_growth, gross_margin, debt_equity |
| **SEC EDGAR** | `data.sec.gov/submissions` | recent filings (8-K, 10-Q, etc.) |

### 3.4 News/Catalyst Data

| Provider | Endpoint | Data Points |
|----------|----------|-------------|
| **Finnhub** | `/company-news` | headline, source, datetime, sentiment |
| **Alpha Vantage** | `NEWS_SENTIMENT` | news with sentiment scores |

---

## 4. Scoring Algorithms

### 4.1 Attention Score (0-100)

```javascript
function calculateAttentionScore(ticker) {
  // Inputs from aggregators
  const swaggyMentions = data.swaggy?.mentions || 0;
  const swaggyNetSentiment = data.swaggy?.net_sentiment || 0; // -100 to 100
  const apewisdomRank = data.apewisdom?.rank || 999;
  const apewisdomMentions = data.apewisdom?.mentions || 0;
  const altindexScore = data.altindex?.social_score || 50;

  // Normalize each component (0-100)
  const mentionScore = Math.min(100, ((swaggyMentions + apewisdomMentions) / 200) * 100);
  const sentimentScore = ((swaggyNetSentiment + 100) / 200) * 100;
  const rankScore = Math.max(0, 100 - (apewisdomRank * 2));
  const altScore = altindexScore;

  // Momentum bonus: mentions today vs 7-day avg
  const mentionMomentum = data.swaggy?.momentum || 1;
  const momentumBonus = mentionMomentum > 3 ? 20 : mentionMomentum > 2 ? 10 : 0;

  // Weighted average
  const baseScore = (mentionScore * 0.3) + (sentimentScore * 0.25) +
                    (rankScore * 0.25) + (altScore * 0.2);

  return Math.min(100, baseScore + momentumBonus);
}
```

### 4.2 Momentum Score (0-100)

```javascript
function calculateMomentumScore(ticker) {
  // Price action
  const dailyChange = data.price.change_percent; // e.g., 5.2 for 5.2%
  const weeklyChange = data.price.change_5d_percent;
  const monthlyChange = data.price.change_30d_percent;

  // Volume
  const relativeVolume = data.volume.current / data.volume.avg_30d;

  // Technical position
  const distanceFrom52wLow = ((data.price.current - data.price.low_52w) / data.price.low_52w) * 100;
  const distanceFrom52wHigh = ((data.price.high_52w - data.price.current) / data.price.high_52w) * 100;

  // Score components
  const dailyMoveScore = Math.min(30, dailyChange * 2); // cap at 30 for 15%+ move
  const volumeScore = Math.min(30, (relativeVolume - 1) * 10); // cap at 30 for 4x volume
  const trendScore = monthlyChange > 0 ? Math.min(20, monthlyChange) : 0;
  const positionScore = distanceFrom52wHigh > 30 ? 20 : 10; // more room to run

  return Math.max(0, Math.min(100, dailyMoveScore + volumeScore + trendScore + positionScore));
}
```

### 4.3 Fundamentals Score (0-100)

```javascript
function calculateFundamentalsScore(ticker) {
  let score = 50; // neutral starting point

  // Valuation (if available)
  if (data.fundamentals.pe_ratio) {
    if (data.fundamentals.pe_ratio > 0 && data.fundamentals.pe_ratio < 15) score += 15;
    else if (data.fundamentals.pe_ratio < 0) score -= 10; // unprofitable
    else if (data.fundamentals.pe_ratio > 50) score -= 5;
  }

  // Market cap tier
  if (data.fundamentals.market_cap) {
    if (data.fundamentals.market_cap > 100_000_000) score += 10; // > $100M = more legit
    if (data.fundamentals.market_cap < 10_000_000) score -= 15; // < $10M = very risky
  }

  // Revenue/Growth
  if (data.fundamentals.revenue_growth > 20) score += 15;
  else if (data.fundamentals.revenue_growth > 0) score += 5;
  else if (data.fundamentals.revenue_growth < -20) score -= 10;

  // Profitability
  if (data.fundamentals.gross_margin > 40) score += 10;
  if (data.fundamentals.operating_margin > 0) score += 10;

  // Debt/Cash position
  if (data.fundamentals.debt_equity < 0.5) score += 10;
  else if (data.fundamentals.debt_equity > 2) score -= 15;

  // Has recent SEC filings (legitimate company)
  if (data.fundamentals.recent_filings > 0) score += 5;

  return Math.max(0, Math.min(100, score));
}
```

### 4.4 Risk Score (Pump & Dump Probability) (0-100)

```javascript
function calculateRiskScore(ticker) {
  let riskScore = 20; // baseline risk for penny stocks

  // Extreme attention + poor fundamentals = high risk
  if (attentionScore > 80 && fundamentalsScore < 30) riskScore += 30;

  // Massive volume spike with no news
  const relativeVolume = data.volume.current / data.volume.avg_30d;
  if (relativeVolume > 10 && !data.news.hasRecentNews) riskScore += 25;

  // Single-source hype (only trending on one platform)
  const sourcesWithMentions = [
    data.swaggy?.mentions > 10,
    data.apewisdom?.mentions > 10,
    data.altindex?.mentions > 10
  ].filter(Boolean).length;
  if (sourcesWithMentions === 1 && attentionScore > 60) riskScore += 15;

  // Micro-float with big move
  if (data.fundamentals.shares_outstanding < 10_000_000 &&
      data.price.change_percent > 30) riskScore += 20;

  // Very low market cap
  if (data.fundamentals.market_cap < 5_000_000) riskScore += 15;

  // No recent SEC filings
  if (data.fundamentals.recent_filings === 0) riskScore += 10;

  // OTC vs major exchange
  if (data.fundamentals.exchange?.includes('OTC')) riskScore += 10;

  return Math.min(100, riskScore);
}
```

---

## 5. Alert Logic & Classification

### Classification Rules

```javascript
function classifyTicker(scores) {
  const { attention, momentum, fundamentals, risk } = scores;

  // High risk = avoid regardless of other scores
  if (risk > 80) {
    return { classification: 'avoid', reason: 'High pump-and-dump probability' };
  }

  // Runner: high attention + high momentum, fundamentals don't matter as much
  if (attention > 70 && momentum > 70) {
    return { classification: 'runner', reason: 'High sentiment momentum play' };
  }

  // Value: good fundamentals + moderate momentum (catalyst brewing)
  if (fundamentals > 70 && momentum >= 30 && momentum <= 70) {
    return { classification: 'value', reason: 'Strong fundamentals with building momentum' };
  }

  // Both: rare but possible
  if (attention > 60 && momentum > 60 && fundamentals > 60 && risk < 50) {
    return { classification: 'both', reason: 'Quality company with momentum and attention' };
  }

  // Default
  return { classification: 'watch', reason: 'Does not meet criteria' };
}
```

### Alert Triggers

| Alert Type | Conditions | Channel |
|------------|------------|---------|
| **Runner Alert** | `attention > 70 AND momentum > 70 AND risk < 70` | Email + Slack (immediate) |
| **Value Alert** | `fundamentals > 70 AND momentum 30-70 AND risk < 60` | Email (digest) |
| **Both Alert** | `classification === 'both'` | Email + Slack (immediate) |
| **Pump Warning** | `risk > 80` | Log only (for analysis) |

---

## 6. Database Schema (PostgreSQL)

### Tables

```sql
-- Stores each hourly scan run
CREATE TABLE scan_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tickers_scanned INT,
  alerts_generated INT,
  status VARCHAR(20) -- 'completed', 'failed', 'partial'
);

-- Main results table - one row per ticker per run
CREATE TABLE scan_results (
  id SERIAL PRIMARY KEY,
  run_id UUID REFERENCES scan_runs(run_id),
  run_timestamp TIMESTAMPTZ NOT NULL,
  ticker VARCHAR(10) NOT NULL,

  -- Raw sentiment data
  swaggy_mentions INT,
  swaggy_sentiment DECIMAL(5,2),
  swaggy_momentum DECIMAL(5,2),
  apewisdom_rank INT,
  apewisdom_mentions INT,
  altindex_score DECIMAL(5,2),

  -- Raw price data
  price DECIMAL(10,4),
  price_change_1d DECIMAL(8,4),
  price_change_5d DECIMAL(8,4),
  price_change_30d DECIMAL(8,4),
  volume BIGINT,
  avg_volume_30d BIGINT,
  relative_volume DECIMAL(6,2),

  -- Raw fundamental data
  market_cap BIGINT,
  pe_ratio DECIMAL(10,2),
  ps_ratio DECIMAL(10,2),
  revenue_growth DECIMAL(8,2),
  gross_margin DECIMAL(8,2),
  debt_equity DECIMAL(8,2),
  exchange VARCHAR(20),
  sector VARCHAR(50),

  -- Computed scores
  attention_score INT CHECK (attention_score BETWEEN 0 AND 100),
  momentum_score INT CHECK (momentum_score BETWEEN 0 AND 100),
  fundamentals_score INT CHECK (fundamentals_score BETWEEN 0 AND 100),
  risk_score INT CHECK (risk_score BETWEEN 0 AND 100),

  -- Classification
  classification VARCHAR(20), -- 'runner', 'value', 'both', 'avoid', 'watch'
  confidence DECIMAL(3,2),
  bull_case TEXT,
  bear_case TEXT,
  catalysts TEXT[],

  -- Alert flags
  alert_triggered BOOLEAN DEFAULT FALSE,
  alert_type VARCHAR(20),

  -- Future returns (populated later for backtesting)
  return_1d DECIMAL(8,4),
  return_3d DECIMAL(8,4),
  return_5d DECIMAL(8,4),
  max_gain_5d DECIMAL(8,4),
  max_drawdown_5d DECIMAL(8,4),

  -- Indexes
  CONSTRAINT unique_ticker_run UNIQUE (ticker, run_id)
);

-- Indexes for common queries
CREATE INDEX idx_scan_results_timestamp ON scan_results(run_timestamp);
CREATE INDEX idx_scan_results_ticker ON scan_results(ticker);
CREATE INDEX idx_scan_results_classification ON scan_results(classification);
CREATE INDEX idx_scan_results_attention ON scan_results(attention_score);
CREATE INDEX idx_scan_results_alert ON scan_results(alert_triggered);

-- Alerts history
CREATE TABLE alerts (
  id SERIAL PRIMARY KEY,
  scan_result_id INT REFERENCES scan_results(id),
  ticker VARCHAR(10),
  alert_type VARCHAR(20),
  alert_timestamp TIMESTAMPTZ DEFAULT NOW(),
  scores JSONB,
  message TEXT,
  sent_to VARCHAR(50)[] -- ['email', 'slack']
);
```

---

## 7. n8n Workflow Structure (v3)

### Node Sequence

```
1. [Cron Trigger] - Every hour, market hours only
       │
       ▼
2. [HTTP Nodes - Parallel]
   ├── Swaggy API
   ├── ApeWisdom API
   ├── AltIndex API
   └── Reddit Scrape (backup)
       │
       ▼
3. [Code: NormalizeSentiment]
   - Convert each source to: {ticker, source, mentions, sentiment, momentum}
       │
       ▼
4. [Code: MergeByTicker]
   - Aggregate all sources by ticker
   - Compute weighted totals
       │
       ▼
5. [HTTP Nodes - Sequential per ticker]
   ├── Alpha Vantage Overview
   ├── Finnhub Profile/Metrics
   └── Finnhub Quote (current price)
       │
       ▼
6. [Code: UniverseFilter]
   - Drop: non-US, non-OTC, price > $10, market_cap > $20B, ETFs
       │
       ▼
7. [Code: FeatureEngineering]
   - Calculate: attention_score, momentum_score, fundamentals_score, risk_score
   - Output: 0-100 normalized scores + raw metrics
       │
       ▼
8. [LLM Node: Claude Classification]
   - Input: scores + metrics
   - Output: {classification, confidence, bull_case, bear_case, catalysts}
       │
       ▼
9. [Code: AlertLogic]
   - Apply thresholds for runner/value/pump alerts
   - Tag each ticker with alert_type if triggered
       │
       ▼
10. [Split by Alert Type]
    │
    ├── [IF: Runner Alert] → [Email Node] + [Slack Node]
    ├── [IF: Value Alert] → [Email Node]
    └── [IF: Pump Warning] → [Log Only]
       │
       ▼
11. [PostgreSQL Node: Insert Results]
    - Write all tickers to scan_results table
       │
       ▼
12. [Code: BuildJSONResponse]
    - Format for web dashboard API
```

---

## 8. Web Dashboard (React/Next.js)

### Pages

| Page | Purpose |
|------|---------|
| `/` | Current screener results - sortable table with scores |
| `/ticker/[symbol]` | Drill-down: chart, score breakdown, history, news |
| `/alerts` | Alert history with filters by type/date |
| `/backtest` | Historical performance analysis |
| `/settings` | Configure alert thresholds, email, slack webhook |

### Key Components

```
src/
├── app/
│   ├── page.tsx              # Main screener table
│   ├── ticker/[symbol]/
│   │   └── page.tsx          # Ticker detail view
│   ├── alerts/
│   │   └── page.tsx          # Alert history
│   ├── backtest/
│   │   └── page.tsx          # Backtest dashboard
│   └── api/
│       ├── screener/
│       │   └── route.ts      # GET current results
│       ├── ticker/[symbol]/
│       │   └── route.ts      # GET ticker detail + history
│       └── alerts/
│           └── route.ts      # GET alert history
├── components/
│   ├── ScreenerTable.tsx     # Main results table
│   ├── ScoreGauge.tsx        # Visual score indicator
│   ├── ClassificationBadge.tsx
│   ├── PriceChart.tsx        # TradingView lightweight
│   └── AlertCard.tsx
└── lib/
    ├── db.ts                 # Postgres connection
    └── scoring.ts            # Shared scoring logic
```

---

## 9. Implementation Phases

### Phase 1: Data Pipeline (Week 1)
- [ ] Set up PostgreSQL database with schema
- [ ] Create n8n workflow skeleton with Cron trigger
- [ ] Implement Swaggy, ApeWisdom, AltIndex HTTP nodes
- [ ] Build NormalizeSentiment and MergeByTicker code nodes
- [ ] Add Alpha Vantage/Finnhub enrichment nodes
- [ ] Implement UniverseFilter (US/OTC, price <= $10)

### Phase 2: Scoring Engine (Week 2)
- [ ] Build FeatureEngineering code node with all 4 scoring functions
- [ ] Test scoring logic with sample data
- [ ] Implement Claude classification node with structured JSON output
- [ ] Add AlertLogic code node with threshold rules

### Phase 3: Storage & Alerts (Week 3)
- [ ] Connect PostgreSQL node to write scan_results
- [ ] Set up Email and Slack alert nodes
- [ ] Implement alert routing logic (runner/value/pump)
- [ ] Add scan_runs metadata tracking
- [ ] Test full pipeline end-to-end

### Phase 4: Web Dashboard (Week 4)
- [ ] Set up Next.js project with Tailwind
- [ ] Build ScreenerTable component with sorting/filtering
- [ ] Create API routes for screener data
- [ ] Implement ticker detail page with charts
- [ ] Add alert history view

### Phase 5: Backtesting & Refinement (Week 5+)
- [ ] Build job to backfill return_1d, return_3d, return_5d columns
- [ ] Create backtest analysis dashboard
- [ ] Tune scoring weights based on historical performance
- [ ] Add additional data sources if needed

---

## 10. API Keys Required

| Service | Key Type | Where to Get |
|---------|----------|--------------|
| Alpha Vantage | API Key | https://www.alphavantage.co/support/#api-key |
| Finnhub | API Key | https://finnhub.io/register |
| SwaggyStocks | API Key | https://swaggystock.com/api |
| ApeWisdom | None | Public API |
| AltIndex | Subscription | https://altindex.com/pricing |
| OpenAI/Claude | API Key | For LLM classification |
| SendGrid/SMTP | API Key | For email alerts |
| Slack | Webhook URL | For Slack alerts |

---

## 11. Risk Considerations

1. **API Rate Limits**: Implement caching and batching; may need paid tiers for hourly runs
2. **Data Quality**: Sentiment aggregators may have gaps; use multiple sources for redundancy
3. **False Positives**: Expect noise in penny stock screening; backtest thresholds aggressively
4. **Latency**: Hourly is sufficient for swing trades; intraday would need different architecture
5. **OTC Data**: Less reliable fundamental data; weight fundamentals_score lower for OTC

---

## 12. Next Steps

1. **Confirm API access** for Swaggy, AltIndex (may need subscriptions)
2. **Set up PostgreSQL** database locally or cloud (Supabase/Railway)
3. **Start with Phase 1** - get data flowing into n8n
4. **Iterate on scoring** - the algorithms above are starting points; tune based on backtest results
