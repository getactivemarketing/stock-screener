-- Migration 011: Speculative tier for meme/squeeze candidates
-- Additive only. Safe to run against live DB.
-- Date: 2026-04-16
--
-- Adds a tier dimension distinguishing 'core' (standard value+catalyst) from
-- 'speculative' (loosened gates for social-velocity-driven small caps).
-- Speculative positions have smaller sizes, tighter stops, shorter holds,
-- and separate portfolio limits.

-- scan_results already has a 'tier' column from the dual-tier era (values
-- 'MOMENTUM'/'QUALITY', currently null for unified runs). Reuse it for the
-- new core/speculative distinction — backfill null rows to 'core'.
ALTER TABLE scan_results
  ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'core';
UPDATE scan_results SET tier = 'core' WHERE tier IS NULL OR tier IN ('MOMENTUM', 'QUALITY');

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'core';
UPDATE trades SET tier = 'core' WHERE tier IS NULL;

ALTER TABLE portfolio_state
  ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'core';
UPDATE portfolio_state SET tier = 'core' WHERE tier IS NULL;

ALTER TABLE trading_config
  ADD COLUMN IF NOT EXISTS speculative_enabled            BOOLEAN      DEFAULT false,
  ADD COLUMN IF NOT EXISTS speculative_position_pct       NUMERIC(5,2) DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS speculative_max_positions      INT          DEFAULT 5,
  ADD COLUMN IF NOT EXISTS speculative_portfolio_heat_pct NUMERIC(5,2) DEFAULT 8.0,
  ADD COLUMN IF NOT EXISTS speculative_stop_loss_pct      NUMERIC(5,2) DEFAULT 15.0,
  ADD COLUMN IF NOT EXISTS speculative_max_hold_days      INT          DEFAULT 5,
  ADD COLUMN IF NOT EXISTS speculative_min_composite      NUMERIC(5,2) DEFAULT 50.0;

CREATE INDEX IF NOT EXISTS idx_scan_results_tier ON scan_results (tier);
CREATE INDEX IF NOT EXISTS idx_trades_tier       ON trades (tier);
