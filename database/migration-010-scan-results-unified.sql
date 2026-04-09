-- Migration 010: Add unified screener columns to scan_results
-- Additive only. Safe to run against live DB.
-- Date: 2026-04-09

ALTER TABLE scan_results
  ADD COLUMN IF NOT EXISTS entry_category     TEXT,
  ADD COLUMN IF NOT EXISTS catalyst_date      DATE,
  ADD COLUMN IF NOT EXISTS composite_score    SMALLINT,
  ADD COLUMN IF NOT EXISTS upside_score       SMALLINT,
  ADD COLUMN IF NOT EXISTS expected_return_30d NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS conviction_score   SMALLINT;

CREATE INDEX IF NOT EXISTS idx_scan_results_entry_category ON scan_results (entry_category);
CREATE INDEX IF NOT EXISTS idx_scan_results_composite      ON scan_results (composite_score DESC);
