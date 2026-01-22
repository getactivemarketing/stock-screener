-- Stock Screener Database Schema
-- PostgreSQL

-- Extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Stores each hourly scan run
CREATE TABLE IF NOT EXISTS scan_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tickers_scanned INT DEFAULT 0,
  alerts_generated INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'running', -- 'running', 'completed', 'failed', 'partial'
  error_message TEXT,
  duration_ms INT
);

-- Main results table - one row per ticker per run
CREATE TABLE IF NOT EXISTS scan_results (
  id SERIAL PRIMARY KEY,
  run_id UUID REFERENCES scan_runs(run_id) ON DELETE CASCADE,
  run_timestamp TIMESTAMPTZ NOT NULL,
  ticker VARCHAR(10) NOT NULL,

  -- Raw sentiment data
  swaggy_mentions INT,
  swaggy_sentiment DECIMAL(5,2),
  swaggy_momentum DECIMAL(5,2),
  apewisdom_rank INT,
  apewisdom_mentions INT,
  altindex_score DECIMAL(5,2),
  total_mentions INT,
  avg_sentiment DECIMAL(5,2),
  source_count INT,

  -- Raw price data
  price DECIMAL(10,4),
  price_change_1d DECIMAL(10,4),
  price_change_1d_pct DECIMAL(8,4),
  price_change_5d DECIMAL(10,4),
  price_change_5d_pct DECIMAL(8,4),
  price_change_30d DECIMAL(10,4),
  price_change_30d_pct DECIMAL(8,4),
  volume BIGINT,
  avg_volume_30d BIGINT,
  relative_volume DECIMAL(8,2),
  high_52w DECIMAL(10,4),
  low_52w DECIMAL(10,4),

  -- Raw fundamental data
  company_name VARCHAR(255),
  market_cap BIGINT,
  pe_ratio DECIMAL(10,2),
  ps_ratio DECIMAL(10,2),
  pb_ratio DECIMAL(10,2),
  revenue_growth DECIMAL(8,2),
  gross_margin DECIMAL(8,2),
  operating_margin DECIMAL(8,2),
  debt_equity DECIMAL(8,2),
  exchange VARCHAR(20),
  sector VARCHAR(100),
  industry VARCHAR(100),
  country VARCHAR(50),

  -- Computed scores (0-100)
  attention_score INT CHECK (attention_score BETWEEN 0 AND 100),
  momentum_score INT CHECK (momentum_score BETWEEN 0 AND 100),
  fundamentals_score INT CHECK (fundamentals_score BETWEEN 0 AND 100),
  risk_score INT CHECK (risk_score BETWEEN 0 AND 100),

  -- Classification from LLM
  classification VARCHAR(20), -- 'runner', 'value', 'both', 'avoid', 'watch'
  confidence DECIMAL(3,2),
  bull_case TEXT,
  bear_case TEXT,
  catalysts TEXT[],

  -- Alert flags
  alert_triggered BOOLEAN DEFAULT FALSE,
  alert_type VARCHAR(20), -- 'runner', 'value', 'both', 'pump_warning'

  -- Target prices (buy/sell recommendations)
  target_technical DECIMAL(10,4),    -- Based on support/resistance, 52w high/low
  target_fundamental DECIMAL(10,4),  -- Based on fair value from ratios
  target_ai DECIMAL(10,4),           -- AI-generated target
  target_risk DECIMAL(10,4),         -- Risk-based (+20% target)
  target_avg DECIMAL(10,4),          -- Average of all methods
  stop_loss DECIMAL(10,4),           -- Stop loss price
  target_details JSONB,              -- Detailed breakdown of each method

  -- Future returns (populated later for backtesting)
  return_1d DECIMAL(8,4),
  return_3d DECIMAL(8,4),
  return_5d DECIMAL(8,4),
  max_gain_5d DECIMAL(8,4),
  max_drawdown_5d DECIMAL(8,4),

  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_ticker_run UNIQUE (ticker, run_id)
);

-- Alerts history
CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  scan_result_id INT REFERENCES scan_results(id) ON DELETE CASCADE,
  ticker VARCHAR(10) NOT NULL,
  alert_type VARCHAR(20) NOT NULL,
  alert_timestamp TIMESTAMPTZ DEFAULT NOW(),
  scores JSONB,
  classification JSONB,
  message TEXT,
  sent_to TEXT[] -- ['email', 'slack']
);

-- Historical price data for backtesting
CREATE TABLE IF NOT EXISTS price_history (
  id SERIAL PRIMARY KEY,
  ticker VARCHAR(10) NOT NULL,
  date DATE NOT NULL,
  open DECIMAL(10,4),
  high DECIMAL(10,4),
  low DECIMAL(10,4),
  close DECIMAL(10,4),
  volume BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_ticker_date UNIQUE (ticker, date)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_scan_results_timestamp ON scan_results(run_timestamp);
CREATE INDEX IF NOT EXISTS idx_scan_results_ticker ON scan_results(ticker);
CREATE INDEX IF NOT EXISTS idx_scan_results_classification ON scan_results(classification);
CREATE INDEX IF NOT EXISTS idx_scan_results_attention ON scan_results(attention_score);
CREATE INDEX IF NOT EXISTS idx_scan_results_alert ON scan_results(alert_triggered);
CREATE INDEX IF NOT EXISTS idx_scan_results_run_id ON scan_results(run_id);
CREATE INDEX IF NOT EXISTS idx_alerts_ticker ON alerts(ticker);
CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(alert_timestamp);
CREATE INDEX IF NOT EXISTS idx_price_history_ticker_date ON price_history(ticker, date);

-- View for latest scan results
CREATE OR REPLACE VIEW latest_scan AS
SELECT sr.*
FROM scan_results sr
INNER JOIN (
  SELECT MAX(run_timestamp) as max_ts
  FROM scan_runs
  WHERE status = 'completed'
) latest ON sr.run_timestamp = latest.max_ts;

-- View for alert statistics
CREATE OR REPLACE VIEW alert_stats AS
SELECT
  alert_type,
  DATE(alert_timestamp) as alert_date,
  COUNT(*) as alert_count,
  AVG((scores->>'attention')::int) as avg_attention,
  AVG((scores->>'momentum')::int) as avg_momentum
FROM alerts
GROUP BY alert_type, DATE(alert_timestamp)
ORDER BY alert_date DESC;
