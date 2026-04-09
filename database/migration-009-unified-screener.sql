-- migration-009-unified-screener.sql
-- Adds attribution logging to trades, portfolio_state category tracking,
-- and tradeability metadata on scan_results.
-- Additive-only. Safe to run on live DB.

BEGIN;

-- Attribution logging on trades
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS entry_value_score    INT,
  ADD COLUMN IF NOT EXISTS entry_catalyst_score INT,
  ADD COLUMN IF NOT EXISTS entry_upside_score   INT,
  ADD COLUMN IF NOT EXISTS entry_risk_score     INT,
  ADD COLUMN IF NOT EXISTS entry_composite      INT,
  ADD COLUMN IF NOT EXISTS entry_category       TEXT,
  ADD COLUMN IF NOT EXISTS entry_catalyst_type  TEXT,
  ADD COLUMN IF NOT EXISTS entry_catalyst_date  DATE,
  ADD COLUMN IF NOT EXISTS exit_value_score     INT,
  ADD COLUMN IF NOT EXISTS exit_catalyst_score  INT,
  ADD COLUMN IF NOT EXISTS exit_upside_score    INT,
  ADD COLUMN IF NOT EXISTS exit_risk_score      INT,
  ADD COLUMN IF NOT EXISTS exit_composite       INT,
  ADD COLUMN IF NOT EXISTS exit_reason          TEXT;

-- Category tracking on portfolio_state for sell evaluation
ALTER TABLE portfolio_state
  ADD COLUMN IF NOT EXISTS entry_category      TEXT,
  ADD COLUMN IF NOT EXISTS entry_catalyst_date DATE;

-- Tradeability metadata on scan_results
ALTER TABLE scan_results
  ADD COLUMN IF NOT EXISTS tradeable     BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS gate_failures TEXT[];

COMMIT;
