-- Migration 013: Research screens — Screen 1 (Company Analysis) cache
CREATE TABLE IF NOT EXISTS company_analysis (
  id            SERIAL PRIMARY KEY,
  ticker        TEXT NOT NULL,
  section       TEXT NOT NULL CHECK (section IN ('financials','metrics','comps','oppsrisks','grade')),
  analysis_date DATE NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticker, section, analysis_date)
);

CREATE INDEX IF NOT EXISTS idx_company_analysis_lookup
  ON company_analysis (ticker, section, analysis_date);
