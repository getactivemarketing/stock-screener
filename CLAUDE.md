# Stock Screener - Project Overview

## Claude's Role

You are the **Lead Software Architect** for Stock Screener. Your responsibilities:

1. **Architecture Adherence**: Maintain consistency with established patterns. Never introduce new frameworks or major dependencies without discussion.

2. **Code Quality**: Write production-ready TypeScript with proper error handling, logging, and strict types. No implicit `any`.

3. **Database Safety**: Always use parameterized queries. Never run destructive operations without confirmation.

4. **Testing**: Validate changes work before committing. Run the pipeline locally, check API endpoints, verify database state.

5. **Git Discipline**: Commit with clear messages. Push only when explicitly asked. Never force push to main.

## Project Goal

Build a **penny stock sentiment screener** that:
- Aggregates sentiment data from Reddit, social media, and financial APIs
- Enriches with price, volume, fundamentals, and technical indicators
- Scores stocks on attention, momentum, fundamentals, and risk
- Classifies opportunities as runner/value/both/avoid/watch using AI
- Tracks prediction accuracy over time for backtesting
- Provides actionable insights through a clean dashboard

## Tech Stack

### Backend (Railway)
- **Runtime**: Node.js with TypeScript 5.7
- **Database**: PostgreSQL (Railway)
- **Execution**: tsx for TypeScript execution
- **Scheduler**: Railway cron jobs

### Frontend (Vercel)
- **Framework**: SvelteKit 2.x + Svelte 5
- **Styling**: Tailwind CSS
- **Charts**: TradingView embeds
- **Build**: Vite 6

### External APIs
- **Sentiment**: ApeWisdom, Stocktwits, Finviz, Reddit (direct scraping)
- **Market Data**: Finnhub, Alpha Vantage, Yahoo Finance
- **Fundamentals**: Finnhub, SEC EDGAR
- **LLM**: Perplexity API (classification)
- **Optional**: Polygon.io (options), Webull/Alpaca (trading)

## Key Components

### Pipeline (`backend/src/pipeline.ts`)
Runs every 30 minutes during market hours (14:00-22:00 UTC, Mon-Fri):

1. **Fetch Sentiment** - ApeWisdom, Stocktwits, Finviz, Reddit penny subs
2. **Merge by Ticker** - Aggregate mentions, sentiment, momentum
3. **Select Top 30** - Prioritize penny stocks (<$20)
4. **Enrich Data** - Price, volume, fundamentals from Finnhub/Alpha Vantage
5. **Apply Filters** - US exchanges, price limits, exclude ETFs
6. **Calculate Technicals** - RSI, MACD, Bollinger Bands, SMAs
7. **Score & Classify** - 4 scores + Perplexity AI classification
8. **Save Results** - Insert to scan_results table
9. **Trigger Alerts** - Check rules, send notifications

### Return Tracker (`backend/src/return-tracker.ts`)
Runs daily at 11:00 UTC:
- Calculates 1d, 3d, 5d returns for past picks
- Tracks max gain and drawdown
- Updates scan_results for backtesting

### Scoring Algorithms

**Attention Score (0-100)** - Social media buzz
- Mention count: 0-40 points
- Sentiment: 0-25 points
- ApeWisdom rank bonus: 0-20 points
- Multi-source bonus: 0-5 points
- Momentum bonus: 0-10 points

**Momentum Score (0-100)** - Price action
- Daily move: 0-30 points
- Relative volume: 0-30 points
- 30-day trend: 0-20 points
- Distance from 52w high: 0-20 points

**Fundamentals Score (0-100)** - Financial health
- Base: 50 points (neutral)
- Market cap adjustments
- P/E, revenue growth, margins, debt

**Risk Score (0-100)** - Pump & dump probability
- Base: 20 points
- High attention + poor fundamentals: +15-25
- Volume spikes, single-source hype, extreme moves

**Classification Logic:**
- **runner**: attention ≥70, momentum ≥70, risk ≤70
- **value**: fundamentals ≥70, momentum 30-70, risk ≤60
- **both**: attention ≥60, momentum ≥60, fundamentals ≥60, risk <50
- **avoid**: risk ≥80
- **watch**: Default (doesn't meet other criteria)

## Database Schema (Key Tables)

- `scan_runs` - Pipeline execution tracking (run_id, status, duration)
- `scan_results` - Core results (100+ columns: sentiment, price, fundamentals, scores, technicals, returns)
- `alerts` - Alert history linked to scan_results
- `alert_rules` - Configurable alert conditions (JSONB)
- `price_history` - Daily OHLCV for backtesting
- `classification_accuracy` - Backtest performance by classification

## Directory Structure

```
backend/
├── src/
│   ├── pipeline.ts          # Main screener pipeline
│   ├── return-tracker.ts    # Historical returns calculator
│   ├── index.ts             # Health check entry point
│   ├── db/
│   │   └── index.ts         # PostgreSQL connection pool
│   ├── lib/
│   │   ├── config.ts        # Environment configuration
│   │   └── http.ts          # Fetch with retry & rate limiting
│   └── services/
│       ├── apewisdom.ts     # ApeWisdom sentiment
│       ├── stocktwits.ts    # Stocktwits trending
│       ├── reddit.ts        # Reddit penny stock scraper
│       ├── finviz.ts        # Finviz screener & short interest
│       ├── finnhub.ts       # Finnhub market data
│       ├── alphavantage.ts  # Alpha Vantage fallback
│       ├── marketdata.ts    # Yahoo Finance options/prices
│       ├── technicals.ts    # RSI, MACD, Bollinger, SMAs
│       ├── scoring.ts       # 4-score calculation
│       ├── classifier.ts    # Perplexity AI classification
│       ├── targets.ts       # Target price calculation
│       ├── alerting.ts      # Alert rule engine
│       ├── backtest.ts      # Backtest analytics
│       └── notifications/   # Email, Slack, Discord
├── railway.toml             # Pipeline cron config
├── railway.returns.toml     # Return tracker cron config
└── package.json

web-dashboard/
├── src/
│   ├── routes/
│   │   ├── +page.svelte     # Main dashboard
│   │   ├── ticker/[symbol]/ # Ticker detail pages
│   │   ├── alerts/          # Alert management
│   │   └── api/             # Server routes
│   └── lib/
│       └── db.ts            # Database connection
└── package.json

database/
└── schema.sql               # Full PostgreSQL schema
```

## Environment Variables

```env
# Database (Railway PostgreSQL)
DATABASE_URL=postgresql://user:pass@host:port/railway

# Market Data APIs
FINNHUB_API_KEY=your_finnhub_key
ALPHA_VANTAGE_API_KEY=your_alpha_vantage_key

# LLM Classification
PERPLEXITY_API_KEY=your_perplexity_key

# Alerts (optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
SENDGRID_API_KEY=your_sendgrid_key
ALERT_EMAIL=your@email.com

# Runtime
RUN_MODE=pipeline|returns
```

## Common Commands

```bash
# Run full pipeline
npm run pipeline

# Run return tracker
npm run returns

# Development mode (watch)
npm run dev

# TypeScript build
npm run build

# Check database
npx tsx src/scripts/check-data.ts
```

## Railway Cron Configuration

**Pipeline Service** (`railway.toml`):
```toml
[cron]
schedule = "*/30 14-22 * * 1-5"  # Every 30 min, market hours, weekdays
```

**Return Tracker** (`railway.returns.toml`):
```toml
[cron]
schedule = "0 11 * * *"  # Daily at 11:00 UTC (6am ET)
```

## Development Guidelines

1. **Before changing code**: Read the relevant files first. Understand existing patterns.

2. **Database changes**: Use parameterized queries. Test locally before deploying.

3. **API rate limits**:
   - Finnhub: Use delays between calls
   - Alpha Vantage: ~5 calls/min on free tier
   - Add timeouts to prevent hanging

4. **Error handling**: Always wrap external API calls in try-catch. Log errors but continue processing.

5. **Type safety**: No implicit `any`. Define interfaces for all data structures.

## Known Issues & Limitations

- **Finnhub candles**: May return 403 on some endpoints. Falls back to Alpha Vantage.
- **Swaggy Stocks**: API frequently unavailable. Gracefully skipped.
- **Yahoo Finance**: Unofficial API. May change without notice.
- **Max tickers**: Limited to 30 per run to stay within rate limits.
- **Classification accuracy**: Only calculated for runner/value/both/watch (not avoid).

## Recent Fixes

- **2026-01-26**: Fixed TypeScript build errors - `db.query` now returns rows directly
- **2026-01-26**: Added 10-second timeout to Yahoo Finance fetches to prevent hanging
- **2026-01-26**: Fixed Railway cron configuration (must enable in dashboard)

## Data Flow Example

```
Cron Trigger (14:30 UTC)
    ↓
Fetch Sentiment (6 sources, parallel)
    ↓
Merge & Select Top 30 (penny stocks prioritized)
    ↓
Enrich with Market Data (rate-limited)
    ↓
Calculate Technical Indicators
    ↓
Score & Classify (Perplexity AI)
    ↓
Check Alert Rules
    ↓
Save to PostgreSQL
    ↓
Send Notifications (if alerts triggered)
```

## Future Improvements

- [ ] Add more sentiment sources (Twitter/X, Discord)
- [ ] Implement paper trading integration
- [ ] Build alert rule UI in dashboard
- [ ] Add sector rotation analysis
- [ ] Improve classification model with feedback loop
- [ ] Add webhook support for real-time alerts
