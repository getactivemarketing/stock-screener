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

  -- Technical indicators
  rsi_14 DECIMAL(5,2),
  macd_value DECIMAL(10,4),
  macd_signal DECIMAL(10,4),
  macd_histogram DECIMAL(10,4),
  bb_upper DECIMAL(10,4),
  bb_middle DECIMAL(10,4),
  bb_lower DECIMAL(10,4),
  sma_20 DECIMAL(10,4),
  sma_50 DECIMAL(10,4),
  sma_200 DECIMAL(10,4),
  ema_20 DECIMAL(10,4),
  technical_signal VARCHAR(20), -- 'bullish', 'bearish', 'neutral'
  technical_strength INT CHECK (technical_strength BETWEEN 0 AND 100),

  -- SEC EDGAR data
  sec_recent_filings INT,
  sec_insider_buys INT,
  sec_insider_sells INT,
  sec_latest_8k_date DATE,
  sec_signal VARCHAR(20), -- 'positive', 'negative', 'neutral'

  -- Dark pool data
  dark_pool_volume BIGINT,
  dark_pool_pct DECIMAL(5,2),
  dark_pool_signal VARCHAR(20), -- 'accumulation', 'distribution', 'neutral'

  -- Enhanced options data
  options_call_volume BIGINT,
  options_put_volume BIGINT,
  options_call_put_ratio DECIMAL(5,2),
  options_unusual_activity BOOLEAN,
  options_max_pain DECIMAL(10,2),
  options_signal VARCHAR(20), -- 'bullish', 'bearish', 'neutral'

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
  sent_to TEXT[] -- ['email', 'slack', 'discord']
);

-- Alert rules configuration
CREATE TABLE IF NOT EXISTS alert_rules (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  enabled BOOLEAN DEFAULT true,
  alert_type VARCHAR(30) NOT NULL, -- 'classification', 'price_target', 'technical', 'sec', 'options'
  conditions JSONB NOT NULL, -- {attention_min: 70, momentum_min: 60, classification: ['runner']}
  channels TEXT[] NOT NULL, -- ['email', 'discord', 'slack']
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
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

-- Classification accuracy tracking
CREATE TABLE IF NOT EXISTS classification_accuracy (
  id SERIAL PRIMARY KEY,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  classification VARCHAR(20) NOT NULL,
  total_picks INT NOT NULL DEFAULT 0,
  winners_1d INT NOT NULL DEFAULT 0,
  winners_3d INT NOT NULL DEFAULT 0,
  winners_5d INT NOT NULL DEFAULT 0,
  losers INT NOT NULL DEFAULT 0,
  avg_return_1d DECIMAL(8,2),
  avg_return_3d DECIMAL(8,2),
  avg_return_5d DECIMAL(8,2),
  avg_max_gain DECIMAL(8,2),
  avg_max_drawdown DECIMAL(8,2),
  win_rate_1d DECIMAL(5,2),
  win_rate_5d DECIMAL(5,2),
  sharpe_ratio DECIMAL(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_period_classification UNIQUE (period_start, period_end, classification)
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

-- =====================================================
-- MIGRATIONS - Add new columns to existing tables
-- =====================================================

-- Phase 1: Technical Indicators columns
DO $$
BEGIN
  -- Add technical indicator columns if they don't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'rsi_14') THEN
    ALTER TABLE scan_results ADD COLUMN rsi_14 DECIMAL(5,2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'macd_value') THEN
    ALTER TABLE scan_results ADD COLUMN macd_value DECIMAL(10,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'macd_signal') THEN
    ALTER TABLE scan_results ADD COLUMN macd_signal DECIMAL(10,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'macd_histogram') THEN
    ALTER TABLE scan_results ADD COLUMN macd_histogram DECIMAL(10,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'bb_upper') THEN
    ALTER TABLE scan_results ADD COLUMN bb_upper DECIMAL(10,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'bb_middle') THEN
    ALTER TABLE scan_results ADD COLUMN bb_middle DECIMAL(10,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'bb_lower') THEN
    ALTER TABLE scan_results ADD COLUMN bb_lower DECIMAL(10,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'sma_20') THEN
    ALTER TABLE scan_results ADD COLUMN sma_20 DECIMAL(10,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'sma_50') THEN
    ALTER TABLE scan_results ADD COLUMN sma_50 DECIMAL(10,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'sma_200') THEN
    ALTER TABLE scan_results ADD COLUMN sma_200 DECIMAL(10,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'ema_20') THEN
    ALTER TABLE scan_results ADD COLUMN ema_20 DECIMAL(10,4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'technical_signal') THEN
    ALTER TABLE scan_results ADD COLUMN technical_signal VARCHAR(20);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'technical_strength') THEN
    ALTER TABLE scan_results ADD COLUMN technical_strength INT CHECK (technical_strength BETWEEN 0 AND 100);
  END IF;
END $$;

-- Index for technical signal queries
CREATE INDEX IF NOT EXISTS idx_scan_results_technical ON scan_results(technical_signal);

-- Phase 2: SEC, Dark Pool, and Options columns
DO $$
BEGIN
  -- SEC EDGAR columns
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'sec_recent_filings') THEN
    ALTER TABLE scan_results ADD COLUMN sec_recent_filings INT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'sec_insider_buys') THEN
    ALTER TABLE scan_results ADD COLUMN sec_insider_buys INT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'sec_insider_sells') THEN
    ALTER TABLE scan_results ADD COLUMN sec_insider_sells INT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'sec_latest_8k_date') THEN
    ALTER TABLE scan_results ADD COLUMN sec_latest_8k_date DATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'sec_signal') THEN
    ALTER TABLE scan_results ADD COLUMN sec_signal VARCHAR(20);
  END IF;

  -- Dark Pool columns
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'dark_pool_volume') THEN
    ALTER TABLE scan_results ADD COLUMN dark_pool_volume BIGINT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'dark_pool_pct') THEN
    ALTER TABLE scan_results ADD COLUMN dark_pool_pct DECIMAL(5,2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'dark_pool_signal') THEN
    ALTER TABLE scan_results ADD COLUMN dark_pool_signal VARCHAR(20);
  END IF;

  -- Enhanced Options columns
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'options_call_volume') THEN
    ALTER TABLE scan_results ADD COLUMN options_call_volume BIGINT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'options_put_volume') THEN
    ALTER TABLE scan_results ADD COLUMN options_put_volume BIGINT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'options_call_put_ratio') THEN
    ALTER TABLE scan_results ADD COLUMN options_call_put_ratio DECIMAL(5,2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'options_unusual_activity') THEN
    ALTER TABLE scan_results ADD COLUMN options_unusual_activity BOOLEAN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'options_max_pain') THEN
    ALTER TABLE scan_results ADD COLUMN options_max_pain DECIMAL(10,2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'scan_results' AND column_name = 'options_signal') THEN
    ALTER TABLE scan_results ADD COLUMN options_signal VARCHAR(20);
  END IF;
END $$;

-- Index for options and SEC signals
CREATE INDEX IF NOT EXISTS idx_scan_results_options_signal ON scan_results(options_signal);
CREATE INDEX IF NOT EXISTS idx_scan_results_sec_signal ON scan_results(sec_signal);
