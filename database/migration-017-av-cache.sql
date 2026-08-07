-- Migration 017: raw Alpha Vantage response cache
--
-- The Company Analysis screen builds five sections, and several of them need the
-- same upstream data: financials calls INCOME_STATEMENT + BALANCE_SHEET, metrics
-- calls both again plus OVERVIEW, and grade calls OVERVIEW again. A full
-- five-tab analysis therefore spends ~6 Alpha Vantage calls on 3 distinct
-- payloads, against a free-tier ceiling of roughly 25 calls per day — so a
-- couple of tickers exhausts the quota and later sections silently degrade
-- (Alpha Vantage returns an "Information" note rather than an error).
--
-- company_analysis is not usable for this: a CHECK constraint pins `section` to
-- the five analysis sections, and these rows are upstream responses rather than
-- analysis output. A separate table keeps that distinction honest.
--
-- Keyed by fetch_date so the cache self-expires daily, matching the existing
-- per-day section cache. Fundamentals move quarterly; a day is comfortably safe.
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS av_cache (
  id         SERIAL PRIMARY KEY,
  ticker     TEXT NOT NULL,
  fn         TEXT NOT NULL,
  fetch_date DATE NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticker, fn, fetch_date)
);

CREATE INDEX IF NOT EXISTS idx_av_cache_lookup ON av_cache (ticker, fn, fetch_date);

COMMENT ON TABLE av_cache IS
  'Raw Alpha Vantage responses cached per ticker/function/day to stay inside the '
  'free-tier request ceiling. Safe to truncate; it will refill on demand.';

COMMIT;
