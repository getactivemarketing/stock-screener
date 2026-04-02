-- Migration 007: Automated Trading Tables

-- Executed orders only (BUY/SELL)
CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_result_id INT REFERENCES scan_results(id),
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
