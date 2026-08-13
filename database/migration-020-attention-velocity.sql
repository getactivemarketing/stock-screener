-- Migration 020: attention snapshots + computed velocity
--
-- pipeline-unified.ts merges all sentiment sources into a full universe and then
-- truncates to MAX_CANDIDATES=40 before persisting ~18 rows to scan_results. The
-- full universe is discarded every 30 minutes, so a ticker only enters scan_results
-- AFTER it already made the cut -- there is no "before" value for a stock going
-- 30 -> 180 mentions. These tables capture the whole universe so velocity is
-- computable for tickers the screener has not noticed yet.

CREATE TABLE IF NOT EXISTS attention_snapshots (
  id                  UUID PRIMARY KEY,
  ticker              VARCHAR(10) NOT NULL,
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_mentions      INTEGER NOT NULL,
  apewisdom_mentions  INTEGER,
  apewisdom_rank      INTEGER,
  stocktwits_mentions INTEGER,
  swaggy_mentions     INTEGER,
  sources_present     TEXT[] NOT NULL,
  avg_sentiment       NUMERIC(6,3)
);

CREATE INDEX IF NOT EXISTS idx_att_snap_ticker_time
  ON attention_snapshots (ticker, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_att_snap_time
  ON attention_snapshots (captured_at DESC);

CREATE TABLE IF NOT EXISTS attention_velocity (
  id                UUID PRIMARY KEY,
  ticker            VARCHAR(10) NOT NULL,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  mentions_now      INTEGER NOT NULL,
  vel_1h            NUMERIC(10,2),
  vel_6h            NUMERIC(10,2),
  vel_24h           NUMERIC(10,2),
  vel_7d            NUMERIC(10,2),
  acceleration      NUMERIC(10,2),
  baseline_mentions NUMERIC(10,2),
  sample_count      INTEGER NOT NULL,
  is_reliable       BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_att_vel_time
  ON attention_velocity (computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_att_vel_ticker_time
  ON attention_velocity (ticker, computed_at DESC);
