# Automated Trading Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automated paper trading to the stock screener pipeline — evaluate BUY/HOLD/SELL after each scan, execute via Alpaca, log decisions, send enriched alerts.

**Architecture:** New trading layer sits after the existing pipeline's save step. Three new services (alpaca.ts, trader.ts, risk.ts) + one enriched service (classifier.ts) + database migration. Pipeline calls trader after save; trader evaluates positions against scan results and config thresholds; risk validates before execution; Alpaca places paper orders. All decisions logged for audit. Ships disabled by default.

**Tech Stack:** TypeScript, PostgreSQL, Alpaca REST API (paper trading), Perplexity API (enriched classification), existing fetchWithRetry + RateLimiter patterns.

**Spec:** `docs/superpowers/specs/2026-04-02-automated-trading-design.md`

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `backend/src/services/alpaca.ts` | Alpaca REST client (account, positions, orders, quotes) |
| `backend/src/services/trader.ts` | Trade decision engine (evaluate, execute, reconcile, log) |
| `backend/src/services/risk.ts` | Pre-trade risk validation (position limits, heat, buying power) |
| `database/migration-007-trading.sql` | Schema: trades, trade_decisions, portfolio_state, trading_config |

### Modified Files
| File | Changes |
|------|---------|
| `backend/src/types/index.ts` | Add Alpaca types, TradeDecision, TradingConfig, enriched ClassificationResult |
| `backend/src/lib/config.ts` | Add ALPACA_API_KEY, ALPACA_API_SECRET, ALPACA_PAPER env vars |
| `backend/src/services/classifier.ts` | Add tradeRationale, suggestedPositionPct, keyRisk to prompt + parsing |
| `backend/src/services/backtest.ts` | Add simulateTrading() function |
| `backend/src/pipeline.ts` | Wire Step 8 (reconcile -> evaluate -> execute -> log -> alert) |
| `backend/src/services/alerting.ts` | Add sendTradeAlerts() for enriched trade notifications |

---

## Task 1: Run Return Tracker to Backfill Historical Data

**Files:**
- Run: `backend/src/return-tracker.ts` (no changes)

This is a prerequisite — the Win Rates tab shows "no return data yet" because the return tracker hasn't populated historical results. We need this data to validate thresholds before enabling trading.

- [ ] **Step 1: Check current return data**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import db from './src/db/index.js';
const rows = await db.query('SELECT COUNT(*) as total, COUNT(return_1d) as with_returns FROM scan_results');
console.log('Total scan results:', rows[0].total);
console.log('With return data:', rows[0].with_returns);
await db.close();
"
```

Expected: `with_returns` should be 0 or very low.

- [ ] **Step 2: Run the return tracker**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx src/return-tracker.ts
```

Expected: Should process pending picks and print a win rate summary by classification. Watch for API errors from Yahoo Finance — some may fail gracefully, that's fine.

- [ ] **Step 3: Verify return data was populated**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import db from './src/db/index.js';
const rows = await db.query(\`
  SELECT classification, COUNT(*) as picks,
    ROUND(AVG(return_1d)::numeric, 2) as avg_1d,
    ROUND(AVG(return_5d)::numeric, 2) as avg_5d,
    ROUND(100.0 * COUNT(CASE WHEN return_5d > 0 THEN 1 END) / NULLIF(COUNT(return_5d), 0), 1) as win_rate_5d
  FROM scan_results
  WHERE return_1d IS NOT NULL
  GROUP BY classification
  ORDER BY classification
\`);
console.table(rows);
await db.close();
"
```

Expected: Table showing win rates per classification. Note which classifications have positive avg returns and win rates > 50% — this informs the trading thresholds.

- [ ] **Step 4: Commit a note about backfill results**

No code changes to commit here. Record the results in a comment or note for later reference when tuning trader.ts thresholds.

---

## Task 2: Database Migration — Trading Tables

**Files:**
- Create: `database/migration-007-trading.sql`
- Run against: PostgreSQL (Railway)

- [ ] **Step 1: Write the migration file**

Create `database/migration-007-trading.sql`:

```sql
-- Migration 007: Automated Trading Tables
-- Date: 2026-04-02

-- Executed orders only (BUY/SELL)
CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_result_id UUID REFERENCES scan_results(id),
  run_id UUID,
  ticker VARCHAR(10) NOT NULL,
  action VARCHAR(4) NOT NULL CHECK (action IN ('BUY', 'SELL')),
  quantity INT NOT NULL,
  order_type VARCHAR(4) NOT NULL CHECK (order_type IN ('MKT', 'LMT')),
  limit_price DECIMAL(10,4),
  alpaca_order_id VARCHAR(64),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'filled', 'partial', 'cancelled', 'rejected')),
  filled_price DECIMAL(10,4),
  filled_at TIMESTAMPTZ,
  classification VARCHAR(20),
  confidence DECIMAL(4,3),
  scores JSONB,
  trade_rationale TEXT,
  key_risk TEXT,
  position_size_pct DECIMAL(5,2),
  stop_loss DECIMAL(10,4),
  target_price DECIMAL(10,4),
  config_snapshot JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker);
CREATE INDEX IF NOT EXISTS idx_trades_run_id ON trades(run_id);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);

-- Lightweight log for HOLD/SKIP decisions
CREATE TABLE IF NOT EXISTS trade_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID,
  ticker VARCHAR(10) NOT NULL,
  action VARCHAR(10) NOT NULL CHECK (action IN ('HOLD', 'SKIP')),
  reason TEXT NOT NULL,
  classification VARCHAR(20),
  scores JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_decisions_run_id ON trade_decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_trade_decisions_created ON trade_decisions(created_at);

-- Position snapshot after each pipeline run
CREATE TABLE IF NOT EXISTS portfolio_state (
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
  consecutive_scan_misses INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(run_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_state_run_id ON portfolio_state(run_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_state_ticker ON portfolio_state(ticker);

-- Single-row tunable trading parameters
CREATE TABLE IF NOT EXISTS trading_config (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN DEFAULT FALSE,
  max_positions INT DEFAULT 5,
  max_position_pct DECIMAL(5,2) DEFAULT 10.0,
  max_portfolio_heat_pct DECIMAL(5,2) DEFAULT 40.0,
  min_fundamentals INT DEFAULT 60,
  max_risk INT DEFAULT 40,
  min_momentum INT DEFAULT 30,
  hold_days_max INT DEFAULT 5,
  high_conviction_size_pct DECIMAL(5,2) DEFAULT 15.0,
  high_conviction_min_scores INT DEFAULT 60,
  high_conviction_max_risk INT DEFAULT 30,
  daily_loss_limit_pct DECIMAL(5,2) DEFAULT 5.0,
  scan_miss_max INT DEFAULT 3,
  slippage_pct DECIMAL(5,3) DEFAULT 0.500,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO trading_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: Run the migration**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import db from './src/db/index.js';
import { readFileSync } from 'fs';
const sql = readFileSync('../database/migration-007-trading.sql', 'utf-8');
await db.query(sql);
console.log('Migration 007 applied successfully');
await db.close();
"
```

Expected: "Migration 007 applied successfully" with no errors.

- [ ] **Step 3: Verify tables exist**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import db from './src/db/index.js';
const tables = await db.query(\`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
  AND table_name IN ('trades', 'trade_decisions', 'portfolio_state', 'trading_config')
  ORDER BY table_name
\`);
console.log('Created tables:', tables.map(t => t.table_name));
const config = await db.query('SELECT * FROM trading_config');
console.log('Default config:', config[0]);
await db.close();
"
```

Expected: All 4 tables listed. Config row shows `enabled: false` and all defaults.

- [ ] **Step 4: Commit**

```bash
git add database/migration-007-trading.sql
git commit -m "feat: add trading tables migration (trades, trade_decisions, portfolio_state, trading_config)"
```

---

## Task 3: Add Types and Config for Trading

**Files:**
- Modify: `backend/src/types/index.ts`
- Modify: `backend/src/lib/config.ts`

- [ ] **Step 1: Add trading types to types/index.ts**

Append after the existing `TechnicalIndicators` interface (after line 223):

```typescript
// ── Trading Types ──────────────────────────────────────

export interface TradingConfig {
  enabled: boolean;
  maxPositions: number;
  maxPositionPct: number;
  maxPortfolioHeatPct: number;
  minFundamentals: number;
  maxRisk: number;
  minMomentum: number;
  holdDaysMax: number;
  highConvictionSizePct: number;
  highConvictionMinScores: number;
  highConvictionMaxRisk: number;
  dailyLossLimitPct: number;
  scanMissMax: number;
  slippagePct: number;
}

export interface TradeDecision {
  ticker: string;
  action: 'BUY' | 'SELL' | 'HOLD' | 'SKIP';
  reason: string;
  quantity?: number;
  positionSizePct?: number;
  classification: string;
  scores: Scores;
  tradeRationale?: string;
  keyRisk?: string;
  stopLoss?: number;
  targetPrice?: number;
  scanResultId?: string;
  configSnapshot?: TradingConfig;
}

export interface AlpacaAccount {
  id: string;
  equity: number;
  cash: number;
  buyingPower: number;
  portfolioValue: number;
  dayPl: number;
  dayPlPct: number;
}

export interface AlpacaPosition {
  ticker: string;
  quantity: number;
  avgEntryPrice: number;
  marketValue: number;
  currentPrice: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
  side: string;
}

export interface AlpacaOrder {
  id: string;
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  type: string;
  status: string;
  filledAvgPrice: number | null;
  filledAt: string | null;
  createdAt: string;
}

export interface RiskCheckResult {
  approved: boolean;
  adjustedQuantity?: number;
  reason?: string;
}

// Extended classification result with trade-enriched fields
export interface EnrichedClassificationResult extends ClassificationResult {
  tradeRationale?: string;
  suggestedPositionPct?: number;
  keyRisk?: string;
}
```

- [ ] **Step 2: Add Alpaca env vars to config.ts**

In `config.ts`, add to the `configSchema` object (after line 25, before `nodeEnv`):

```typescript
  // Alpaca Trading (optional)
  alpacaApiKey: z.string().optional(),
  alpacaApiSecret: z.string().optional(),
  alpacaPaper: z.string().default('true'),
```

Add to the `parsed` object (after line 41, before `nodeEnv`):

```typescript
  alpacaApiKey: process.env.ALPACA_API_KEY,
  alpacaApiSecret: process.env.ALPACA_API_SECRET,
  alpacaPaper: process.env.ALPACA_PAPER,
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/types/index.ts backend/src/lib/config.ts
git commit -m "feat: add trading types and Alpaca config env vars"
```

---

## Task 4: Alpaca REST Client

**Files:**
- Create: `backend/src/services/alpaca.ts`

- [ ] **Step 1: Create the Alpaca service**

Create `backend/src/services/alpaca.ts`:

```typescript
import { config } from '../lib/config.js';
import { fetchWithRetry, RateLimiter } from '../lib/http.js';
import type { AlpacaAccount, AlpacaPosition, AlpacaOrder } from '../types/index.js';

const alpacaLimiter = new RateLimiter(1, 350); // ~200 calls/min

function getBaseUrl(): string {
  return config.alpacaPaper !== 'false'
    ? 'https://paper-api.alpaca.markets'
    : 'https://api.alpaca.markets';
}

function getDataUrl(): string {
  return 'https://data.alpaca.markets';
}

function getHeaders(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': config.alpacaApiKey || '',
    'APCA-API-SECRET-KEY': config.alpacaApiSecret || '',
    'Content-Type': 'application/json',
  };
}

export function isAlpacaConfigured(): boolean {
  return !!(config.alpacaApiKey && config.alpacaApiSecret);
}

export async function getAccount(): Promise<AlpacaAccount> {
  const raw = await fetchWithRetry<any>(
    `${getBaseUrl()}/v2/account`,
    { headers: getHeaders() },
    alpacaLimiter
  );
  return {
    id: raw.id,
    equity: parseFloat(raw.equity),
    cash: parseFloat(raw.cash),
    buyingPower: parseFloat(raw.buying_power),
    portfolioValue: parseFloat(raw.portfolio_value),
    dayPl: parseFloat(raw.equity) - parseFloat(raw.last_equity),
    dayPlPct: ((parseFloat(raw.equity) - parseFloat(raw.last_equity)) / parseFloat(raw.last_equity)) * 100,
  };
}

export async function getPositions(): Promise<AlpacaPosition[]> {
  const raw = await fetchWithRetry<any[]>(
    `${getBaseUrl()}/v2/positions`,
    { headers: getHeaders() },
    alpacaLimiter
  );
  return raw.map((p) => ({
    ticker: p.symbol,
    quantity: parseInt(p.qty),
    avgEntryPrice: parseFloat(p.avg_entry_price),
    marketValue: parseFloat(p.market_value),
    currentPrice: parseFloat(p.current_price),
    unrealizedPl: parseFloat(p.unrealized_pl),
    unrealizedPlPct: parseFloat(p.unrealized_plpc) * 100,
    side: p.side,
  }));
}

export async function getPosition(ticker: string): Promise<AlpacaPosition | null> {
  try {
    const raw = await fetchWithRetry<any>(
      `${getBaseUrl()}/v2/positions/${ticker}`,
      { headers: getHeaders() },
      alpacaLimiter
    );
    return {
      ticker: raw.symbol,
      quantity: parseInt(raw.qty),
      avgEntryPrice: parseFloat(raw.avg_entry_price),
      marketValue: parseFloat(raw.market_value),
      currentPrice: parseFloat(raw.current_price),
      unrealizedPl: parseFloat(raw.unrealized_pl),
      unrealizedPlPct: parseFloat(raw.unrealized_plpc) * 100,
      side: raw.side,
    };
  } catch {
    return null; // Position not found
  }
}

interface PlaceOrderParams {
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  type: 'market' | 'limit';
  limitPrice?: number;
}

export async function placeOrder(params: PlaceOrderParams): Promise<AlpacaOrder> {
  const body: Record<string, unknown> = {
    symbol: params.ticker,
    qty: params.quantity.toString(),
    side: params.side,
    type: params.type,
    time_in_force: 'day',
  };
  if (params.type === 'limit' && params.limitPrice) {
    body.limit_price = params.limitPrice.toString();
  }

  const raw = await fetchWithRetry<any>(
    `${getBaseUrl()}/v2/orders`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    },
    alpacaLimiter
  );
  return parseOrder(raw);
}

export async function cancelOrder(orderId: string): Promise<void> {
  await fetchWithRetry<any>(
    `${getBaseUrl()}/v2/orders/${orderId}`,
    { method: 'DELETE', headers: getHeaders() },
    alpacaLimiter
  );
}

export async function getOrders(status?: 'open' | 'closed' | 'all'): Promise<AlpacaOrder[]> {
  const params = new URLSearchParams({ limit: '50' });
  if (status) params.set('status', status);

  const raw = await fetchWithRetry<any[]>(
    `${getBaseUrl()}/v2/orders?${params}`,
    { headers: getHeaders() },
    alpacaLimiter
  );
  return raw.map(parseOrder);
}

export async function getQuote(ticker: string): Promise<{ askPrice: number; bidPrice: number; lastPrice: number }> {
  const raw = await fetchWithRetry<any>(
    `${getDataUrl()}/v2/stocks/${ticker}/quotes/latest`,
    { headers: getHeaders() },
    alpacaLimiter
  );
  return {
    askPrice: raw.quote?.ap ?? 0,
    bidPrice: raw.quote?.bp ?? 0,
    lastPrice: (raw.quote?.ap + raw.quote?.bp) / 2 || 0,
  };
}

function parseOrder(raw: any): AlpacaOrder {
  return {
    id: raw.id,
    ticker: raw.symbol,
    side: raw.side,
    quantity: parseInt(raw.qty),
    type: raw.type,
    status: raw.status,
    filledAvgPrice: raw.filled_avg_price ? parseFloat(raw.filled_avg_price) : null,
    filledAt: raw.filled_at || null,
    createdAt: raw.created_at,
  };
}

export default {
  isAlpacaConfigured,
  getAccount,
  getPositions,
  getPosition,
  placeOrder,
  cancelOrder,
  getOrders,
  getQuote,
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/alpaca.ts
git commit -m "feat: add Alpaca REST client for paper trading"
```

---

## Task 5: Risk Validation Service

**Files:**
- Create: `backend/src/services/risk.ts`

- [ ] **Step 1: Create the risk service**

Create `backend/src/services/risk.ts`:

```typescript
import type { AlpacaAccount, AlpacaPosition, TradingConfig, RiskCheckResult } from '../types/index.js';

/**
 * Pre-trade risk validation. Called before every BUY order.
 */
export function validateBuy(
  ticker: string,
  orderValue: number,
  account: AlpacaAccount,
  positions: AlpacaPosition[],
  config: TradingConfig
): RiskCheckResult {
  // Check daily loss limit — blocks ALL buys
  if (account.dayPlPct <= -config.dailyLossLimitPct) {
    return { approved: false, reason: `Daily loss limit hit (${account.dayPlPct.toFixed(2)}% <= -${config.dailyLossLimitPct}%)` };
  }

  // Check max positions
  if (positions.length >= config.maxPositions) {
    return { approved: false, reason: `Max positions reached (${positions.length}/${config.maxPositions})` };
  }

  // Check no duplicate position
  if (positions.some((p) => p.ticker === ticker)) {
    return { approved: false, reason: `Already holding ${ticker}` };
  }

  // Check buying power
  if (orderValue > account.buyingPower) {
    return { approved: false, reason: `Insufficient buying power ($${orderValue.toFixed(2)} > $${account.buyingPower.toFixed(2)})` };
  }

  // Check position size as % of portfolio
  const positionPct = (orderValue / account.portfolioValue) * 100;
  if (positionPct > config.maxPositionPct) {
    // Reduce to max allowed
    const adjustedValue = account.portfolioValue * (config.maxPositionPct / 100);
    const adjustedQuantity = Math.floor(adjustedValue / (orderValue / Math.ceil(orderValue / account.portfolioValue)));
    if (adjustedQuantity < 1) {
      return { approved: false, reason: `Position too small after size adjustment` };
    }
    return { approved: true, adjustedQuantity, reason: `Position size reduced to ${config.maxPositionPct}% of portfolio` };
  }

  // Check portfolio heat (total exposure)
  const totalExposure = positions.reduce((sum, p) => sum + p.marketValue, 0) + orderValue;
  const heatPct = (totalExposure / account.portfolioValue) * 100;
  if (heatPct > config.maxPortfolioHeatPct) {
    return { approved: false, reason: `Portfolio heat too high (${heatPct.toFixed(1)}% > ${config.maxPortfolioHeatPct}%)` };
  }

  return { approved: true };
}

export default { validateBuy };
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/risk.ts
git commit -m "feat: add pre-trade risk validation service"
```

---

## Task 6: Enrich Classifier Prompt

**Files:**
- Modify: `backend/src/services/classifier.ts`

- [ ] **Step 1: Update the AnalysisWithTarget interface**

In `classifier.ts`, update the `AnalysisWithTarget` interface (line 18) to include enriched fields:

```typescript
export interface AnalysisWithTarget extends ClassificationResult {
  targetPrice?: AITargetPrice;
  tradeRationale?: string;
  suggestedPositionPct?: number;
  keyRisk?: string;
}
```

- [ ] **Step 2: Update the prompt to request enriched fields**

In the `buildPrompt()` function, replace the JSON response format section (lines 114-126) with:

```typescript
Respond with ONLY a JSON object (no markdown, no explanation):
{
  "classification": "runner" | "value" | "both" | "avoid" | "watch",
  "confidence": 0.0-1.0,
  "bullCase": "1-2 sentence bull case",
  "bearCase": "1-2 sentence bear case",
  "catalysts": ["catalyst1", "catalyst2"],
  "targetPrice": {
    "target": number (your price target in dollars),
    "reasoning": "1-2 sentence explanation for target",
    "confidence": 0.0-1.0
  },
  "tradeRationale": "1-2 sentence core thesis for why this is or isn't a trade (e.g. 'High retail attention + improving fundamentals suggest short-term momentum play')",
  "suggestedPositionPct": 0-15 (suggested portfolio allocation percentage, 0 if avoid),
  "keyRisk": "1 sentence describing the single biggest risk to the thesis"
}`;
```

- [ ] **Step 3: Update parseResponse to extract enriched fields**

In the `parseResponse()` function, update the return statement in the try block (around line 157) to include the new fields:

```typescript
    return {
      classification: validateClassification(parsed.classification) || fallbackClassification,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      bullCase: typeof parsed.bullCase === 'string' ? parsed.bullCase : 'Analysis unavailable',
      bearCase: typeof parsed.bearCase === 'string' ? parsed.bearCase : 'Analysis unavailable',
      catalysts: Array.isArray(parsed.catalysts) ? parsed.catalysts.filter((c: unknown) => typeof c === 'string') : [],
      targetPrice,
      tradeRationale: typeof parsed.tradeRationale === 'string' ? parsed.tradeRationale : undefined,
      suggestedPositionPct: typeof parsed.suggestedPositionPct === 'number'
        ? Math.max(0, Math.min(15, parsed.suggestedPositionPct))
        : undefined,
      keyRisk: typeof parsed.keyRisk === 'string' ? parsed.keyRisk : undefined,
    };
```

Also generate a fallback rationale from bull/bear case when Perplexity omits it. After the return statement above, in the fallback/error return blocks, add:

```typescript
      // In the fallback (no tradeRationale from Perplexity), synthesize from bull case
      tradeRationale: typeof parsed.tradeRationale === 'string'
        ? parsed.tradeRationale
        : typeof parsed.bullCase === 'string'
          ? `AI assessment: ${parsed.bullCase}`
          : undefined,
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/classifier.ts
git commit -m "feat: enrich classifier prompt with tradeRationale, suggestedPositionPct, keyRisk"
```

---

## Task 7: Trade Decision Engine (trader.ts)

**Files:**
- Create: `backend/src/services/trader.ts`

This is the core service. It evaluates pipeline results against current positions and config, produces BUY/HOLD/SELL decisions, executes them via Alpaca, and logs everything.

- [ ] **Step 1: Create trader.ts**

Create `backend/src/services/trader.ts`:

```typescript
import { v4 as uuidv4 } from 'uuid';
import db from '../db/index.js';
import * as alpaca from './alpaca.js';
import { validateBuy } from './risk.js';
import type {
  TickerAnalysis,
  TradingConfig,
  TradeDecision,
  AlpacaAccount,
  AlpacaPosition,
  Scores,
} from '../types/index.js';
import type { TargetPrices } from './targets.js';
import type { TechnicalIndicators } from './technicals.js';
import type { AnalysisWithTarget } from './classifier.js';

type FullAnalysis = TickerAnalysis & { targets: TargetPrices; technicals: TechnicalIndicators | null };

/**
 * Load trading config from the database
 */
export async function loadTradingConfig(): Promise<TradingConfig> {
  const rows = await db.query<any>('SELECT * FROM trading_config WHERE id = 1');
  if (rows.length === 0) throw new Error('trading_config row not found');
  const c = rows[0];
  return {
    enabled: c.enabled,
    maxPositions: c.max_positions,
    maxPositionPct: parseFloat(c.max_position_pct),
    maxPortfolioHeatPct: parseFloat(c.max_portfolio_heat_pct),
    minFundamentals: c.min_fundamentals,
    maxRisk: c.max_risk,
    minMomentum: c.min_momentum,
    holdDaysMax: c.hold_days_max,
    highConvictionSizePct: parseFloat(c.high_conviction_size_pct),
    highConvictionMinScores: c.high_conviction_min_scores,
    highConvictionMaxRisk: c.high_conviction_max_risk,
    dailyLossLimitPct: parseFloat(c.daily_loss_limit_pct),
    scanMissMax: c.scan_miss_max,
    slippagePct: parseFloat(c.slippage_pct),
  };
}

/**
 * Reconcile pending orders from previous runs.
 * Polls Alpaca for open/recently-filled orders and updates the trades table.
 */
export async function reconcilePendingOrders(): Promise<void> {
  const pendingTrades = await db.query<{ id: string; alpaca_order_id: string }>(
    `SELECT id, alpaca_order_id FROM trades WHERE status = 'pending' AND alpaca_order_id IS NOT NULL`
  );
  if (pendingTrades.length === 0) return;

  console.log(`[Trader] Reconciling ${pendingTrades.length} pending orders...`);
  const orders = await alpaca.getOrders('all');
  const orderMap = new Map(orders.map((o) => [o.id, o]));

  for (const trade of pendingTrades) {
    const order = orderMap.get(trade.alpaca_order_id);
    if (!order) continue;

    const newStatus = mapAlpacaStatus(order.status);
    if (newStatus === 'pending') continue; // Still open

    await db.query(
      `UPDATE trades SET status = $1, filled_price = $2, filled_at = $3, updated_at = NOW() WHERE id = $4`,
      [newStatus, order.filledAvgPrice, order.filledAt, trade.id]
    );
    console.log(`[Trader] Reconciled ${trade.alpaca_order_id}: ${newStatus} @ $${order.filledAvgPrice}`);
  }
}

function mapAlpacaStatus(status: string): string {
  switch (status) {
    case 'filled': return 'filled';
    case 'partially_filled': return 'partial';
    case 'canceled': case 'expired': case 'suspended': return 'cancelled';
    case 'rejected': return 'rejected';
    default: return 'pending';
  }
}

/**
 * Evaluate all pipeline results + held positions and produce trade decisions.
 */
export async function evaluate(
  results: FullAnalysis[],
  positions: AlpacaPosition[],
  account: AlpacaAccount,
  tradingConfig: TradingConfig
): Promise<TradeDecision[]> {
  const decisions: TradeDecision[] = [];
  const resultTickers = new Set(results.map((r) => r.ticker));

  // 1. Evaluate SELL for existing positions
  for (const pos of positions) {
    const latestScan = results.find((r) => r.ticker === pos.ticker);
    const sellDecision = evaluateSell(pos, latestScan, tradingConfig, resultTickers);
    decisions.push(sellDecision);
  }

  // 2. Evaluate BUY for new opportunities
  const heldTickers = new Set(positions.map((p) => p.ticker));
  const pendingSells = decisions.filter((d) => d.action === 'SELL').length;
  const effectivePositions = positions.length - pendingSells;

  for (const analysis of results) {
    if (heldTickers.has(analysis.ticker)) continue; // Already evaluated as HOLD/SELL

    const buyDecision = evaluateBuy(analysis, account, positions, tradingConfig, effectivePositions);
    decisions.push(buyDecision);

    if (buyDecision.action === 'BUY') {
      // Account for this new position in subsequent evaluations
      effectivePositions;
    }
  }

  return decisions;
}

function evaluateSell(
  position: AlpacaPosition,
  latestScan: FullAnalysis | undefined,
  config: TradingConfig,
  resultTickers: Set<string>
): TradeDecision {
  const baseDecision = {
    ticker: position.ticker,
    classification: latestScan?.classification.classification || 'unknown',
    scores: latestScan?.scores || { attention: 0, momentum: 0, fundamentals: 0, risk: 0 },
    tradeRationale: (latestScan?.classification as any)?.tradeRationale,
    keyRisk: (latestScan?.classification as any)?.keyRisk,
  };

  // Check stop-loss (evaluated at 30-min granularity — see spec note)
  if (latestScan && latestScan.targets?.stopLoss && position.currentPrice <= latestScan.targets.stopLoss) {
    return {
      ...baseDecision,
      action: 'SELL',
      reason: `Stop-loss hit: $${position.currentPrice.toFixed(2)} <= $${latestScan.targets.stopLoss.toFixed(2)}`,
      quantity: position.quantity,
      stopLoss: latestScan.targets.stopLoss,
    };
  }

  // Check reclassified to AVOID
  if (latestScan?.classification.classification === 'avoid') {
    return {
      ...baseDecision,
      action: 'SELL',
      reason: `Reclassified to AVOID (risk: ${latestScan.scores.risk})`,
      quantity: position.quantity,
    };
  }

  // Check max hold days (approximate from entry price comparison)
  // We'll get precise days_held from portfolio_state
  const entryInfo = await getEntryInfo(position.ticker);
  if (entryInfo && entryInfo.daysHeld >= config.holdDaysMax) {
    return {
      ...baseDecision,
      action: 'SELL',
      reason: `Max hold period reached (${entryInfo.daysHeld} >= ${config.holdDaysMax} days)`,
      quantity: position.quantity,
    };
  }

  // Check scan miss (ticker absent from scan results)
  if (!resultTickers.has(position.ticker)) {
    const missCount = entryInfo ? entryInfo.consecutiveScanMisses + 1 : 1;
    if (missCount >= config.scanMissMax) {
      return {
        ...baseDecision,
        action: 'SELL',
        reason: `Absent from ${missCount} consecutive scans (max: ${config.scanMissMax})`,
        quantity: position.quantity,
      };
    }
  }

  // HOLD
  return {
    ...baseDecision,
    action: 'HOLD',
    reason: latestScan
      ? `Holding: ${latestScan.classification.classification} classification, ${position.unrealizedPlPct.toFixed(1)}% P&L`
      : `Holding: absent from current scan (miss tracking)`,
  };
}

function evaluateBuy(
  analysis: FullAnalysis,
  account: AlpacaAccount,
  positions: AlpacaPosition[],
  config: TradingConfig,
  currentPositionCount: number
): TradeDecision {
  const { ticker, scores, classification, targets } = analysis;
  const enriched = classification as any; // Access enriched fields

  const baseDecision: TradeDecision = {
    ticker,
    action: 'SKIP',
    reason: '',
    classification: classification.classification,
    scores,
    tradeRationale: enriched.tradeRationale,
    keyRisk: enriched.keyRisk,
    stopLoss: targets?.stopLoss,
    targetPrice: targets?.targetAvg,
    scanResultId: undefined, // Set during logging
  };

  // Check classification
  const validClassifications = ['runner', 'value', 'both'];
  if (!validClassifications.includes(classification.classification)) {
    return { ...baseDecision, reason: `Classification "${classification.classification}" not actionable` };
  }

  // Check score thresholds
  if (scores.fundamentals < config.minFundamentals) {
    return { ...baseDecision, reason: `Fundamentals ${scores.fundamentals} < ${config.minFundamentals}` };
  }
  if (scores.risk > config.maxRisk) {
    return { ...baseDecision, reason: `Risk ${scores.risk} > ${config.maxRisk}` };
  }
  if (scores.momentum < config.minMomentum) {
    return { ...baseDecision, reason: `Momentum ${scores.momentum} < ${config.minMomentum}` };
  }

  // Calculate position size
  const isHighConviction =
    scores.attention >= config.highConvictionMinScores &&
    scores.momentum >= config.highConvictionMinScores &&
    scores.fundamentals >= config.highConvictionMinScores &&
    scores.risk < config.highConvictionMaxRisk;

  const sizePct = isHighConviction ? config.highConvictionSizePct : config.maxPositionPct;
  const orderValue = account.portfolioValue * (sizePct / 100);
  const price = analysis.price.price;
  const quantity = Math.floor(orderValue / price);

  if (quantity < 1) {
    return { ...baseDecision, reason: `Position too small (price $${price}, order value $${orderValue.toFixed(2)})` };
  }

  // Risk check
  const riskResult = validateBuy(ticker, quantity * price, account, positions, config);
  if (!riskResult.approved) {
    return { ...baseDecision, reason: `Risk check failed: ${riskResult.reason}` };
  }

  const finalQuantity = riskResult.adjustedQuantity ?? quantity;

  return {
    ...baseDecision,
    action: 'BUY',
    reason: `${classification.classification.toUpperCase()}${isHighConviction ? ' (high conviction)' : ''}: ` +
      `A:${scores.attention} M:${scores.momentum} F:${scores.fundamentals} R:${scores.risk}`,
    quantity: finalQuantity,
    positionSizePct: sizePct,
    configSnapshot: config,
  };
}

async function getEntryInfo(ticker: string): Promise<{ daysHeld: number; consecutiveScanMisses: number } | null> {
  const rows = await db.query<any>(
    `SELECT days_held, consecutive_scan_misses FROM portfolio_state
     WHERE ticker = $1 ORDER BY created_at DESC LIMIT 1`,
    [ticker]
  );
  if (rows.length === 0) return null;
  return {
    daysHeld: rows[0].days_held || 0,
    consecutiveScanMisses: rows[0].consecutive_scan_misses || 0,
  };
}

/**
 * Execute trade decisions via Alpaca and return updated decisions with order IDs.
 */
export async function execute(decisions: TradeDecision[]): Promise<TradeDecision[]> {
  const executed: TradeDecision[] = [];

  for (const decision of decisions) {
    if (decision.action === 'BUY' && decision.quantity) {
      try {
        const order = await alpaca.placeOrder({
          ticker: decision.ticker,
          side: 'buy',
          quantity: decision.quantity,
          type: 'market',
        });
        console.log(`[Trader] BUY ${decision.quantity} ${decision.ticker} -> order ${order.id} (${order.status})`);
        executed.push({ ...decision, scanResultId: order.id });
      } catch (error) {
        console.error(`[Trader] Failed to buy ${decision.ticker}:`, error);
        executed.push({ ...decision, action: 'SKIP', reason: `Order failed: ${(error as Error).message}` });
      }
    } else if (decision.action === 'SELL' && decision.quantity) {
      try {
        const order = await alpaca.placeOrder({
          ticker: decision.ticker,
          side: 'sell',
          quantity: decision.quantity,
          type: 'market',
        });
        console.log(`[Trader] SELL ${decision.quantity} ${decision.ticker} -> order ${order.id} (${order.status})`);
        executed.push({ ...decision, scanResultId: order.id });
      } catch (error) {
        console.error(`[Trader] Failed to sell ${decision.ticker}:`, error);
        executed.push({ ...decision, action: 'HOLD', reason: `Sell failed: ${(error as Error).message}` });
      }
    } else {
      executed.push(decision);
    }
  }

  return executed;
}

/**
 * Log all decisions to the database.
 * BUY/SELL -> trades table (with config_snapshot)
 * HOLD/SKIP -> trade_decisions table
 */
export async function logDecisions(decisions: TradeDecision[], runId: string): Promise<void> {
  for (const d of decisions) {
    if (d.action === 'BUY' || d.action === 'SELL') {
      // Find the scan_result_id for this ticker in this run
      const scanRows = await db.query<{ id: string }>(
        `SELECT id FROM scan_results WHERE run_id = $1 AND ticker = $2 LIMIT 1`,
        [runId, d.ticker]
      );
      const scanResultId = scanRows[0]?.id || null;

      await db.query(
        `INSERT INTO trades (
          id, scan_result_id, run_id, ticker, action, quantity, order_type,
          alpaca_order_id, status, classification, confidence, scores,
          trade_rationale, key_risk, position_size_pct, stop_loss, target_price,
          config_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6, 'MKT', $7, 'pending', $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          uuidv4(),
          scanResultId,
          runId,
          d.ticker,
          d.action,
          d.quantity || 0,
          d.scanResultId || null, // This holds the alpaca_order_id from execute()
          d.classification,
          null, // confidence — could extract from classification result
          JSON.stringify(d.scores),
          d.tradeRationale || null,
          d.keyRisk || null,
          d.positionSizePct || null,
          d.stopLoss || null,
          d.targetPrice || null,
          d.configSnapshot ? JSON.stringify(d.configSnapshot) : null,
        ]
      );
    } else {
      await db.query(
        `INSERT INTO trade_decisions (id, run_id, ticker, action, reason, classification, scores)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          uuidv4(),
          runId,
          d.ticker,
          d.action,
          d.reason,
          d.classification,
          JSON.stringify(d.scores),
        ]
      );
    }
  }
  console.log(`[Trader] Logged ${decisions.length} decisions (${decisions.filter(d => d.action === 'BUY' || d.action === 'SELL').length} orders, ${decisions.filter(d => d.action === 'HOLD' || d.action === 'SKIP').length} hold/skip)`);
}

/**
 * Update portfolio_state snapshot after trade execution.
 */
export async function updatePortfolioState(
  runId: string,
  results: FullAnalysis[]
): Promise<void> {
  const positions = await alpaca.getPositions();
  const resultTickers = new Set(results.map((r) => r.ticker));

  for (const pos of positions) {
    // Get previous state for days_held and scan miss tracking
    const prev = await getEntryInfo(pos.ticker);
    const daysHeld = prev ? prev.daysHeld + 1 : 0; // Rough increment; refine with entry_date
    const scanMisses = resultTickers.has(pos.ticker) ? 0 : (prev?.consecutiveScanMisses || 0) + 1;

    const latestScan = results.find((r) => r.ticker === pos.ticker);

    await db.query(
      `INSERT INTO portfolio_state (
        id, run_id, ticker, quantity, avg_entry_price, current_price,
        unrealized_pl_pct, entry_date, days_held, classification_at_entry,
        stop_loss, target_price, consecutive_scan_misses
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (run_id, ticker) DO UPDATE SET
        current_price = EXCLUDED.current_price,
        unrealized_pl_pct = EXCLUDED.unrealized_pl_pct,
        days_held = EXCLUDED.days_held,
        consecutive_scan_misses = EXCLUDED.consecutive_scan_misses`,
      [
        uuidv4(),
        runId,
        pos.ticker,
        pos.quantity,
        pos.avgEntryPrice,
        pos.currentPrice,
        pos.unrealizedPlPct,
        prev ? null : new Date(), // Only set entry_date on first snapshot
        daysHeld,
        latestScan?.classification.classification || prev?.consecutiveScanMisses ? 'unknown' : 'unknown',
        latestScan?.targets?.stopLoss || null,
        latestScan?.targets?.targetAvg || null,
        scanMisses,
      ]
    );
  }
  console.log(`[Trader] Portfolio state updated: ${positions.length} positions`);
}

export default {
  loadTradingConfig,
  reconcilePendingOrders,
  evaluate,
  execute,
  logDecisions,
  updatePortfolioState,
};
```

**Note:** The `evaluateSell` function uses `await` inside a non-async function. This needs to be fixed — make `evaluateSell` async and update `evaluate` to await it:

In the `evaluate` function, change the sell evaluation loop to:

```typescript
  // 1. Evaluate SELL for existing positions
  for (const pos of positions) {
    const latestScan = results.find((r) => r.ticker === pos.ticker);
    const sellDecision = await evaluateSell(pos, latestScan, tradingConfig, resultTickers);
    decisions.push(sellDecision);
  }
```

And add `async` to `evaluateSell`:

```typescript
async function evaluateSell(
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsc --noEmit
```

Fix any type errors — common issues will be around the `TargetPrices` type and accessing `targets.stopLoss` vs `targets.targetAvg`. Check the actual `TargetPrices` interface in `services/targets.ts` for the correct property names.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/trader.ts
git commit -m "feat: add trade decision engine with evaluate/execute/log/reconcile"
```

---

## Task 8: Add simulateTrading() to Backtest Service

**Files:**
- Modify: `backend/src/services/backtest.ts`

- [ ] **Step 1: Add simulateTrading function**

Append to `backend/src/services/backtest.ts`:

```typescript
export interface SimulationResult {
  startingCapital: number;
  finalValue: number;
  totalReturn: number;
  totalReturnPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  maxDrawdownPct: number;
  slippageCost: number;
  trades: Array<{
    ticker: string;
    classification: string;
    entryPrice: number;
    exitPrice: number;
    returnPct: number;
    daysHeld: number;
    exitReason: string;
  }>;
}

/**
 * Simulate trading using historical scan results with return data.
 * Applies the same BUY/HOLD/SELL logic as trader.ts retroactively.
 * 
 * NOTE: Historical scan_results will NOT have tradeRationale/suggestedPositionPct/keyRisk
 * since those fields are new. This is expected — enriched fields don't affect trading logic.
 */
export async function simulateTrading(options?: {
  startingCapital?: number;
  slippagePct?: number;
  maxPositions?: number;
  maxPositionPct?: number;
  minFundamentals?: number;
  maxRisk?: number;
  minMomentum?: number;
  holdDaysMax?: number;
}): Promise<SimulationResult> {
  const capital = options?.startingCapital ?? 100000;
  const slippagePct = options?.slippagePct ?? 0.5;
  const maxPositions = options?.maxPositions ?? 5;
  const maxPositionPct = options?.maxPositionPct ?? 10;
  const minFundamentals = options?.minFundamentals ?? 60;
  const maxRisk = options?.maxRisk ?? 40;
  const minMomentum = options?.minMomentum ?? 30;
  const holdDaysMax = options?.holdDaysMax ?? 5;

  // Get all scan results with return data, ordered by date
  const rows = await db.query<any>(`
    SELECT ticker, classification, run_timestamp, price,
           attention_score, momentum_score, fundamentals_score, risk_score,
           return_1d, return_3d, return_5d, max_gain_5d, max_drawdown_5d,
           stop_loss, target_avg
    FROM scan_results
    WHERE return_5d IS NOT NULL
    ORDER BY run_timestamp ASC
  `);

  if (rows.length === 0) {
    return {
      startingCapital: capital, finalValue: capital, totalReturn: 0, totalReturnPct: 0,
      totalTrades: 0, wins: 0, losses: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0,
      maxDrawdownPct: 0, slippageCost: 0, trades: [],
    };
  }

  // Group by run_timestamp (simulate one run at a time)
  const runGroups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.run_timestamp.toISOString();
    if (!runGroups.has(key)) runGroups.set(key, []);
    runGroups.get(key)!.push(row);
  }

  let cash = capital;
  let peakValue = capital;
  let maxDrawdown = 0;
  let totalSlippage = 0;
  let dailyStartValue = capital; // Reset each simulated "day"
  let lastDate = '';
  const openPositions: Array<{
    ticker: string;
    classification: string;
    entryPrice: number;
    quantity: number;
    daysOpen: number;
    stopLoss: number | null;
  }> = [];
  const closedTrades: SimulationResult['trades'] = [];

  for (const [timestamp, scanResults] of runGroups) {
    const currentDate = timestamp.substring(0, 10);

    // Reset daily P&L tracking on new day (mirrors Alpaca behavior)
    if (currentDate !== lastDate) {
      const portfolioValue = cash + openPositions.reduce((s, p) => s + p.entryPrice * p.quantity, 0);
      dailyStartValue = portfolioValue;
      lastDate = currentDate;
    }

    const resultTickers = new Set(scanResults.map((r: any) => r.ticker));

    // SELL evaluation
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      pos.daysOpen++;
      const scan = scanResults.find((r: any) => r.ticker === pos.ticker);
      let sellReason = '';

      if (scan && pos.stopLoss && scan.price <= pos.stopLoss) {
        sellReason = 'stop-loss';
      } else if (scan?.classification === 'avoid') {
        sellReason = 'reclassified-avoid';
      } else if (pos.daysOpen >= holdDaysMax) {
        sellReason = 'max-hold';
      } else if (!resultTickers.has(pos.ticker)) {
        sellReason = 'absent-from-scan';
      }

      if (sellReason) {
        const exitPrice = scan ? scan.price : pos.entryPrice; // If absent, assume flat
        const slippage = exitPrice * (slippagePct / 100);
        const proceeds = (exitPrice - slippage) * pos.quantity;
        totalSlippage += slippage * pos.quantity;
        cash += proceeds;

        closedTrades.push({
          ticker: pos.ticker,
          classification: pos.classification,
          entryPrice: pos.entryPrice,
          exitPrice: exitPrice - slippage,
          returnPct: ((exitPrice - slippage - pos.entryPrice) / pos.entryPrice) * 100,
          daysHeld: pos.daysOpen,
          exitReason: sellReason,
        });
        openPositions.splice(i, 1);
      }
    }

    // BUY evaluation
    for (const scan of scanResults) {
      if (openPositions.length >= maxPositions) break;
      if (openPositions.some((p) => p.ticker === scan.ticker)) continue;

      const validClassifications = ['runner', 'value', 'both'];
      if (!validClassifications.includes(scan.classification)) continue;
      if (scan.fundamentals_score < minFundamentals) continue;
      if (scan.risk_score > maxRisk) continue;
      if (scan.momentum_score < minMomentum) continue;

      // Check daily loss limit
      const portfolioValue = cash + openPositions.reduce((s, p) => s + p.entryPrice * p.quantity, 0);
      const dayPl = ((portfolioValue - dailyStartValue) / dailyStartValue) * 100;
      if (dayPl <= -5) continue; // daily loss limit

      const positionValue = portfolioValue * (maxPositionPct / 100);
      const slippage = scan.price * (slippagePct / 100);
      const buyPrice = scan.price + slippage;
      const quantity = Math.floor(positionValue / buyPrice);
      if (quantity < 1) continue;

      const cost = buyPrice * quantity;
      if (cost > cash) continue;

      totalSlippage += slippage * quantity;
      cash -= cost;
      openPositions.push({
        ticker: scan.ticker,
        classification: scan.classification,
        entryPrice: buyPrice,
        quantity,
        daysOpen: 0,
        stopLoss: scan.stop_loss ? parseFloat(scan.stop_loss) : null,
      });
    }

    // Track max drawdown
    const currentValue = cash + openPositions.reduce((s, p) => s + p.entryPrice * p.quantity, 0);
    if (currentValue > peakValue) peakValue = currentValue;
    const drawdown = ((peakValue - currentValue) / peakValue) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Close remaining positions at last known price (assume flat)
  for (const pos of openPositions) {
    closedTrades.push({
      ticker: pos.ticker,
      classification: pos.classification,
      entryPrice: pos.entryPrice,
      exitPrice: pos.entryPrice,
      returnPct: 0,
      daysHeld: pos.daysOpen,
      exitReason: 'simulation-end',
    });
    cash += pos.entryPrice * pos.quantity;
  }

  const finalValue = cash;
  const wins = closedTrades.filter((t) => t.returnPct > 0);
  const losses = closedTrades.filter((t) => t.returnPct <= 0);

  return {
    startingCapital: capital,
    finalValue,
    totalReturn: finalValue - capital,
    totalReturnPct: ((finalValue - capital) / capital) * 100,
    totalTrades: closedTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0,
    avgWinPct: wins.length > 0 ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : 0,
    avgLossPct: losses.length > 0 ? losses.reduce((s, t) => s + t.returnPct, 0) / losses.length : 0,
    maxDrawdownPct: maxDrawdown,
    slippageCost: totalSlippage,
    trades: closedTrades,
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Quick smoke test**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import { simulateTrading } from './src/services/backtest.js';
const result = await simulateTrading();
console.log('Simulation results:');
console.log('Starting capital:', result.startingCapital);
console.log('Final value:', result.finalValue.toFixed(2));
console.log('Total return:', result.totalReturnPct.toFixed(2) + '%');
console.log('Trades:', result.totalTrades);
console.log('Win rate:', result.winRate.toFixed(1) + '%');
console.log('Max drawdown:', result.maxDrawdownPct.toFixed(2) + '%');
console.log('Slippage cost:', result.slippageCost.toFixed(2));
process.exit(0);
"
```

Expected: Numbers will depend on historical data. If no return data exists yet, all values will be 0.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/backtest.ts
git commit -m "feat: add simulateTrading() for backtest trade simulation with slippage"
```

---

## Task 9: Wire Pipeline Step 8

**Files:**
- Modify: `backend/src/pipeline.ts`

- [ ] **Step 1: Add imports**

At the top of `pipeline.ts`, add after the existing imports (around line 14):

```typescript
import * as trader from './services/trader.js';
import { isAlpacaConfigured } from './services/alpaca.js';
import * as alpacaService from './services/alpaca.js';
```

- [ ] **Step 2: Add Step 8 after saveResults**

In the `runPipeline()` function, after `await saveResults(analyzedTickers);` (line 75) and before `// Step 8: Update run record` (line 77), add:

```typescript
    // Step 8: Automated Trading (if enabled)
    try {
      const tradingConfig = await trader.loadTradingConfig();
      if (tradingConfig.enabled && isAlpacaConfigured()) {
        console.log('\n[8/8] Running automated trading...');

        // 8a. Reconcile pending orders from previous runs
        await trader.reconcilePendingOrders();

        // 8b. Evaluate and execute
        const account = await alpacaService.getAccount();
        const positions = await alpacaService.getPositions();
        const decisions = await trader.evaluate(analyzedTickers, positions, account, tradingConfig);
        const executed = await trader.execute(decisions);
        await trader.logDecisions(executed, RUN_ID);
        await trader.updatePortfolioState(RUN_ID, analyzedTickers);

        // 8c. Send trade alerts
        const tradeActions = executed.filter((d) => d.action === 'BUY' || d.action === 'SELL');
        if (tradeActions.length > 0) {
          console.log(`[Trading] ${tradeActions.length} orders placed`);
        } else {
          console.log('[Trading] No trades this run');
        }
      } else if (!tradingConfig.enabled) {
        console.log('\n[Trading] Disabled in config');
      } else {
        console.log('\n[Trading] Alpaca not configured');
      }
    } catch (tradingError) {
      // Trading errors should not crash the pipeline
      console.error('[Trading] Error (pipeline continues):', tradingError);
    }
```

- [ ] **Step 3: Update the run record step number**

Rename the existing "Step 8: Update run record" comment to "Step 9" since we've inserted a new step:

```typescript
    // Step 9: Update run record
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/pipeline.ts
git commit -m "feat: wire automated trading as pipeline Step 8 (disabled by default)"
```

---

## Task 10: Trade-Enriched Alerts

**Files:**
- Modify: `backend/src/services/alerting.ts`

- [ ] **Step 1: Add sendTradeAlerts function**

Add this function at the end of `alerting.ts` (before the final export if there is one):

```typescript
import type { TradeDecision } from '../types/index.js';

/**
 * Send enriched alerts for trade decisions (BUY/SELL only).
 */
export async function sendTradeAlerts(decisions: TradeDecision[]): Promise<void> {
  const tradeActions = decisions.filter((d) => d.action === 'BUY' || d.action === 'SELL');
  if (tradeActions.length === 0) return;

  const totalPositions = decisions.filter((d) => d.action === 'BUY' || d.action === 'HOLD').length;

  for (const trade of tradeActions) {
    const emoji = trade.action === 'BUY' ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';
    const message = [
      `${emoji} **${trade.action}** ${trade.quantity} shares of **${trade.ticker}**`,
      `Classification: ${trade.classification.toUpperCase()} | Scores: A:${trade.scores.attention} M:${trade.scores.momentum} F:${trade.scores.fundamentals} R:${trade.scores.risk}`,
      trade.tradeRationale ? `Thesis: ${trade.tradeRationale}` : null,
      trade.keyRisk ? `Key Risk: ${trade.keyRisk}` : null,
      trade.stopLoss ? `Stop Loss: $${trade.stopLoss.toFixed(2)}` : null,
      trade.targetPrice ? `Target: $${trade.targetPrice.toFixed(2)}` : null,
      `Reason: ${trade.reason}`,
      `Portfolio: ${totalPositions} positions`,
    ].filter(Boolean).join('\n');

    const payload: AlertPayload = {
      ticker: trade.ticker,
      alertType: `trade_${trade.action.toLowerCase()}`,
      classification: trade.classification,
      scores: trade.scores,
      price: 0, // Not directly available here
      targetPrice: trade.targetPrice || null,
      stopLoss: trade.stopLoss || null,
      bullCase: trade.tradeRationale || trade.reason,
      bearCase: trade.keyRisk || '',
    };

    try {
      await sendDiscordAlert(payload);
    } catch (e) {
      console.error(`[Alerts] Discord trade alert failed for ${trade.ticker}:`, e);
    }
    try {
      await sendSlackAlert(payload);
    } catch (e) {
      console.error(`[Alerts] Slack trade alert failed for ${trade.ticker}:`, e);
    }
  }
  console.log(`[Alerts] Sent ${tradeActions.length} trade alerts`);
}
```

Note: You'll need to add the `TradeDecision` import at the top of the file alongside the existing imports.

- [ ] **Step 2: Wire trade alerts into pipeline Step 8**

In `pipeline.ts`, after the `trader.updatePortfolioState()` call in Step 8, add:

```typescript
        // Import at top of file
        import { sendTradeAlerts } from './services/alerting.js';

        // In Step 8, after updatePortfolioState:
        await sendTradeAlerts(executed);
```

(If `sendTradeAlerts` is already imported via the alerting module, adjust the import accordingly.)

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/alerting.ts backend/src/pipeline.ts
git commit -m "feat: add trade-enriched alert notifications (Slack/Discord)"
```

---

## Task 11: End-to-End Verification

**Files:** No new files — verification only.

- [ ] **Step 1: Verify trading is disabled by default**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import db from './src/db/index.js';
const config = await db.query('SELECT enabled FROM trading_config WHERE id = 1');
console.log('Trading enabled:', config[0]?.enabled);
console.assert(config[0]?.enabled === false, 'Trading should be disabled by default');
await db.close();
"
```

Expected: `Trading enabled: false`

- [ ] **Step 2: Verify full TypeScript build**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsc --noEmit
```

Expected: Clean build, no errors.

- [ ] **Step 3: Dry-run the pipeline (trading disabled)**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx src/pipeline.ts
```

Expected: Pipeline runs through Steps 1-7 as before, Step 8 prints "[Trading] Disabled in config", Step 9 updates the run record. No orders placed.

- [ ] **Step 4: Run backtest simulation**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import { simulateTrading } from './src/services/backtest.js';
const result = await simulateTrading();
console.log('=== Backtest Results ===');
console.log('Starting:', result.startingCapital);
console.log('Final:', result.finalValue.toFixed(2));
console.log('Return:', result.totalReturnPct.toFixed(2) + '%');
console.log('Trades:', result.totalTrades);
console.log('Win Rate:', result.winRate.toFixed(1) + '%');
console.log('Avg Win:', result.avgWinPct.toFixed(2) + '%');
console.log('Avg Loss:', result.avgLossPct.toFixed(2) + '%');
console.log('Max Drawdown:', result.maxDrawdownPct.toFixed(2) + '%');
console.log('Slippage:', result.slippageCost.toFixed(2));
if (result.trades.length > 0) {
  console.log('\nSample trades:');
  result.trades.slice(0, 5).forEach(t => {
    console.log('  ' + t.ticker + ': ' + t.returnPct.toFixed(2) + '% (' + t.exitReason + ', ' + t.daysHeld + 'd)');
  });
}
process.exit(0);
"
```

Expected: If return data was backfilled in Task 1, this will show actual simulation results. If the returns show a positive edge (win rate > 50%, positive total return), the system is ready for paper trading.

- [ ] **Step 5: Commit any final fixes**

If any type errors or issues were found during verification, fix and commit them.

```bash
git add -A
git commit -m "fix: resolve issues found during end-to-end verification"
```

---

## Post-Implementation: Enabling Paper Trading

This is NOT a task in the plan — it's instructions for after you've verified the backtest shows a positive edge.

```sql
-- Enable automated trading
UPDATE trading_config SET enabled = true, updated_at = NOW() WHERE id = 1;

-- To disable (kill switch)
UPDATE trading_config SET enabled = false, updated_at = NOW() WHERE id = 1;
```

Make sure `ALPACA_API_KEY` and `ALPACA_API_SECRET` are set in the Railway backend environment before enabling.
