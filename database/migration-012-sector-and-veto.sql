-- database/migration-012-sector-and-veto.sql
-- Adds sector_candidates table for daily top-down sourcing,
-- veto_* columns on trade_decisions for the veto layer,
-- and three feature flags on trading_config.

BEGIN;

CREATE TABLE IF NOT EXISTS sector_candidates (
  id SERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  ticker VARCHAR(10) NOT NULL,
  sector TEXT,
  rationale TEXT,
  why_now TEXT,
  suggested_tier TEXT CHECK (suggested_tier IN ('momentum', 'quality', 'speculative')),
  used_in_run_id UUID REFERENCES scan_runs(run_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (run_date, ticker)
);

CREATE INDEX IF NOT EXISTS idx_sector_candidates_unused
  ON sector_candidates(run_date)
  WHERE used_in_run_id IS NULL;

ALTER TABLE trade_decisions
  ADD COLUMN IF NOT EXISTS veto_verdict TEXT
    CHECK (veto_verdict IN ('confirm', 'veto', 'downgrade_to_watch')),
  ADD COLUMN IF NOT EXISTS veto_confidence INT
    CHECK (veto_confidence BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS veto_reasoning TEXT,
  ADD COLUMN IF NOT EXISTS veto_key_risk TEXT,
  ADD COLUMN IF NOT EXISTS veto_contradictions JSONB,
  ADD COLUMN IF NOT EXISTS veto_model TEXT,
  ADD COLUMN IF NOT EXISTS veto_latency_ms INT;

ALTER TABLE trading_config
  ADD COLUMN IF NOT EXISTS sector_research_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS veto_layer_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS veto_layer_enforce BOOLEAN DEFAULT FALSE;

COMMIT;
