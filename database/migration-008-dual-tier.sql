-- Migration 008: Dual-Tier Algorithm Support
-- Date: 2026-04-02

-- Tier and lens scores
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS tier VARCHAR(10);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS value_score SMALLINT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS catalyst_score SMALLINT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS emerging_industry_score SMALLINT;

-- Enriched classifier output
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS thesis TEXT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS edge_why_now TEXT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS industry_theme VARCHAR(100);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS stop_loss_pct DECIMAL(5,2);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS expected_returns JSONB;

-- Enrichment data (persisted for audit)
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS analyst_mean_target DECIMAL(10,2);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS analyst_summary TEXT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS earnings_date DATE;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS days_to_earnings INT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS earnings_beat_rate DECIMAL(5,2);
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS news_headlines TEXT[];

-- Tier breakdown per run
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS momentum_count INT;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS quality_count INT;

-- Quality hold period
ALTER TABLE trading_config ADD COLUMN IF NOT EXISTS quality_hold_days_max INT DEFAULT 15;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scan_results_tier ON scan_results(tier);
CREATE INDEX IF NOT EXISTS idx_scan_results_industry_theme ON scan_results(industry_theme);
