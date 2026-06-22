-- Migration 015: minimum holding period — block same-day sells (default ON)
ALTER TABLE trading_config
  ADD COLUMN IF NOT EXISTS no_same_day_sell BOOLEAN NOT NULL DEFAULT true;
