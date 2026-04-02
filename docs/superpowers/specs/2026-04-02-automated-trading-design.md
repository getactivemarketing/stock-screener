# Automated Trading Agent — Design Spec

**Date:** 2026-04-02
**Status:** Approved
**Scope:** Add automated paper trading to the stock screener pipeline via Alpaca

---

## Overview

Extend the existing screener pipeline with an automated trading loop. After each 30-minute pipeline run classifies stocks, a new trader service evaluates BUY/HOLD/SELL decisions, validates them against risk limits, executes via Alpaca paper trading, and sends enriched alerts with trade rationale.

The system ships **disabled by default** — backtest validation must show a positive edge before the trading switch is flipped on.

---

## Database Schema Additions

### `trades` — Audit trail for every automated decision

```sql
CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_result_id UUID REFERENCES scan_results(id),
  run_id UUID,
  ticker VARCHAR(10) NOT NULL,
  action VARCHAR(4) NOT NULL,              -- 'BUY' or 'SELL'
  quantity INT NOT NULL,
  order_type VARCHAR(4) NOT NULL,          -- 'MKT' or 'LMT'
  limit_price DECIMAL(10,4),
  alpaca_order_id VARCHAR(64),
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending/filled/partial/cancelled/rejected
  filled_price DECIMAL(10,4),
  filled_at TIMESTAMPTZ,
  classification VARCHAR(20),
  confidence DECIMAL(4,3),
  scores JSONB,                            -- {attention, momentum, fundamentals, risk}
  trade_rationale TEXT,                     -- From enriched classifier
  key_risk TEXT,                            -- From enriched classifier
  position_size_pct DECIMAL(5,2),
  stop_loss DECIMAL(10,4),
  target_price DECIMAL(10,4),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trades_ticker ON trades(ticker);
CREATE INDEX idx_trades_run_id ON trades(run_id);
CREATE INDEX idx_trades_status ON trades(status);
CREATE INDEX idx_trades_created ON trades(created_at);
```

### `portfolio_state` — Position snapshot after each pipeline run

```sql
CREATE TABLE portfolio_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID,
  ticker VARCHAR(10) NOT NULL,
  quantity INT NOT NULL,
  avg_entry_price DECIMAL(10,4),
  current_price DECIMAL(10,4),
  unrealized_pl_pct DECIMAL(8,4),
  entry_date TIMESTAMPTZ,
  days_held INT,
  classification_at_entry VARCHAR(20),
  stop_loss DECIMAL(10,4),
  target_price DECIMAL(10,4),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_portfolio_state_run_id ON portfolio_state(run_id);
CREATE INDEX idx_portfolio_state_ticker ON portfolio_state(ticker);
```

### `trading_config` — Single-row tunable parameters

```sql
CREATE TABLE trading_config (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- Single row
  enabled BOOLEAN DEFAULT FALSE,
  max_positions INT DEFAULT 5,
  max_position_pct DECIMAL(5,2) DEFAULT 10.0,
  max_portfolio_heat_pct DECIMAL(5,2) DEFAULT 40.0,
  min_fundamentals INT DEFAULT 60,
  max_risk INT DEFAULT 40,
  min_momentum INT DEFAULT 30,
  hold_days_max INT DEFAULT 5,
  high_conviction_size_pct DECIMAL(5,2) DEFAULT 15.0,
  high_conviction_min_scores INT DEFAULT 60,   -- All 4 scores must exceed
  high_conviction_max_risk INT DEFAULT 30,
  daily_loss_limit_pct DECIMAL(5,2) DEFAULT 5.0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO trading_config (id) VALUES (1);
```

---

## New Backend Services

### `backend/src/services/alpaca.ts` — Alpaca REST Client

Direct HTTP calls to Alpaca paper trading API. No SDK dependency.

**Environment variables** (added to `config.ts`):
- `ALPACA_API_KEY` (optional — trading disabled if missing)
- `ALPACA_API_SECRET` (optional — trading disabled if missing)

**Base URL:** `https://paper-api.alpaca.markets`

**Functions:**

| Function | Method | Endpoint | Returns |
|----------|--------|----------|---------|
| `getAccount()` | GET | `/v2/account` | `AlpacaAccount` (equity, cash, buying_power, day_pl) |
| `getPositions()` | GET | `/v2/positions` | `AlpacaPosition[]` (ticker, qty, avg_entry, market_value, unrealized_pl) |
| `getPosition(ticker)` | GET | `/v2/positions/{ticker}` | `AlpacaPosition \| null` |
| `placeOrder(params)` | POST | `/v2/orders` | `AlpacaOrder` (id, status, filled_avg_price) |
| `cancelOrder(orderId)` | DELETE | `/v2/orders/{orderId}` | `void` |
| `getOrders(status?)` | GET | `/v2/orders` | `AlpacaOrder[]` |
| `getQuote(ticker)` | GET | `/v2/stocks/{ticker}/quotes/latest` | `{askPrice, bidPrice, lastPrice}` |

**Error handling:**
- Retry on 429 (rate limit) with exponential backoff
- Log and skip on 4xx (bad ticker, insufficient funds)
- Throw on 5xx (Alpaca outage — pipeline continues, trading skipped)

### `backend/src/services/trader.ts` — Decision Engine

The core trading logic. Called after pipeline saves results.

**Input:** `TickerAnalysis[]` from pipeline + current Alpaca positions + `trading_config`

**Entry criteria (BUY):**
- Classification is `RUNNER`, `VALUE`, or `BOTH`
- `fundamentals_score >= config.min_fundamentals` (default 60)
- `risk_score <= config.max_risk` (default 40)
- `momentum_score >= config.min_momentum` (default 30)
- Not already in portfolio
- Under `config.max_positions` (default 5)
- Passes risk checks

**Position sizing:**
- Default: equal weight, `config.max_position_pct` (10%) of portfolio per ticker
- High conviction (all 4 scores >= 60 AND risk < 30): `config.high_conviction_size_pct` (15%)
- Order type: market orders (penny stocks have wide spreads — limit orders risk non-fill)

**Hold criteria:**
- Position has not hit stop-loss
- Not reclassified to `AVOID` in latest scan
- Days held < `config.hold_days_max` (default 5)

**Exit criteria (SELL):**
- Current price <= `stop_loss` from scan_results
- Latest classification is `AVOID`
- Days held >= `config.hold_days_max`
- Sell entire position (no partial exits for v1)

**Output:** `TradeDecision[]`

```typescript
interface TradeDecision {
  ticker: string;
  action: 'BUY' | 'SELL' | 'HOLD' | 'SKIP';
  reason: string;
  quantity?: number;
  positionSizePct?: number;
  classification: string;
  scores: { attention: number; momentum: number; fundamentals: number; risk: number };
  tradeRationale?: string;  // From enriched classifier
  keyRisk?: string;         // From enriched classifier
  stopLoss?: number;
  targetPrice?: number;
}
```

Every decision (including HOLD and SKIP) is logged to the `trades` table.

### `backend/src/services/risk.ts` — Pre-Trade Risk Validation

Called by trader.ts before every BUY order.

**Checks:**

| Check | Rule | On Failure |
|-------|------|------------|
| Max positions | `currentPositions.length < config.max_positions` | Skip buy |
| Position size | `orderValue / portfolioValue <= config.max_position_pct` | Reduce size |
| Portfolio heat | `totalExposure / portfolioValue <= config.max_portfolio_heat_pct` | Skip buy |
| Buying power | `orderValue <= account.buying_power` | Skip buy |
| Daily loss limit | `account.day_pl_pct > -config.daily_loss_limit_pct` | Skip ALL buys |
| No duplicates | Ticker not already in positions | Skip buy |

Returns `{ approved: boolean, adjustedQuantity?: number, reason?: string }`.

---

## Modified Files

### `backend/src/services/classifier.ts` — Enriched Prompt

Add three new fields to the Perplexity output schema:

```json
{
  "classification": "runner",
  "confidence": 0.85,
  "bullCase": "...",
  "bearCase": "...",
  "catalysts": ["..."],
  "targetPrice": { "target": 4.50, "reasoning": "...", "confidence": 0.7 },
  "tradeRationale": "High retail attention with improving fundamentals suggest short-term momentum play with 15-20% upside potential.",
  "suggestedPositionPct": 10,
  "keyRisk": "Low float + high short interest could trigger either a squeeze or sharp reversal on any negative catalyst."
}
```

Update the prompt to request these. Fallback: generate rationale from bull/bear case if Perplexity omits it.

### `backend/src/pipeline.ts` — Add Step 8

After `saveResults()` at the end of the pipeline:

```
// Step 8: Automated Trading (if enabled)
if (tradingConfig.enabled && alpacaConfigured) {
  const account = await alpaca.getAccount();
  const positions = await alpaca.getPositions();
  const decisions = await trader.evaluate(results, positions, account, tradingConfig);
  const executed = await trader.execute(decisions, alpaca);
  await trader.logDecisions(executed);
  await trader.updatePortfolioState(run_id);
  await alerting.sendTradeAlerts(executed);
}
```

If trading is disabled or Alpaca isn't configured, pipeline works exactly as before.

### `backend/src/services/alerting.ts` — Trade-Enriched Alerts

New function `sendTradeAlerts(decisions: TradeDecision[])`:

For each BUY/SELL decision, send to configured channels with:
- Action taken (e.g., "BOUGHT 50 shares of ABCD @ $3.42")
- Classification + confidence
- Trade rationale (from enriched classifier)
- Key risk
- Stop-loss and target price
- Current portfolio summary (X/5 positions, Y% deployed)

### `backend/src/lib/config.ts` — Add Alpaca Env Vars

```typescript
ALPACA_API_KEY: z.string().optional(),
ALPACA_API_SECRET: z.string().optional(),
```

### `backend/src/services/backtest.ts` — Trade Simulation

New function `simulateTrading(options?)`:
- Loads historical scan_results that have return data populated
- Applies the same trader.ts BUY/HOLD/SELL logic retroactively
- Simulates a $100k starting portfolio
- Calculates: total return, win rate, avg win/loss size, max drawdown, number of trades
- Respects the same position sizing and risk rules as live trading
- Output used to validate edge before enabling real execution

### `backend/src/return-tracker.ts` — No Code Changes

Needs to be run to backfill existing picks. No modifications needed.

---

## Pipeline Flow (Complete)

```
Every 30 minutes (14:00-22:00 UTC, Mon-Fri):

1. Fetch sentiment (ApeWisdom, Swaggy, Stocktwits, Finviz, Reddit)
2. Merge by ticker
3. Select top 30 (60% penny, 40% trending)
4. Enrich with market data (Finnhub, Alpha Vantage)
5. Apply universe filters
6. Calculate technicals (RSI, MACD, Bollinger, SMAs)
7. Score (4 dimensions) + Classify (Perplexity w/ enriched output) + Save
8. Trade execution (if enabled):
   a. Load trading_config → check enabled
   b. Fetch Alpaca account + positions
   c. Evaluate: BUY/HOLD/SELL for each classified ticker
   d. Risk-check each BUY
   e. Execute via Alpaca paper API
   f. Log all decisions to trades table
   g. Snapshot portfolio_state
   h. Send enriched alerts (Slack/Discord/email)
```

---

## Implementation Order

1. **Run return-tracker** — backfill historical returns, validate edge
2. **Database migration** — add trades, portfolio_state, trading_config tables
3. **alpaca.ts** — Alpaca REST client
4. **risk.ts** — pre-trade validation
5. **Enrich classifier.ts** — add tradeRationale, suggestedPositionPct, keyRisk
6. **trader.ts** — decision engine (BUY/HOLD/SELL logic)
7. **backtest.ts** — add simulateTrading() function
8. **pipeline.ts** — wire Step 8
9. **alerting.ts** — trade-enriched notifications
10. **config.ts** — add Alpaca env vars

---

## Out of Scope (v1)

- Live trading (paper only)
- Partial position exits
- Limit orders (market only for v1)
- Webull integration (Alpaca only)
- Rallies Arena cross-signal (Step 5 from original plan — manual for now)
- Dashboard UI changes for trade history (existing portfolio page sufficient)
- Ticker universe expansion (separate effort)
- Real-time streaming (Alpaca websocket)
