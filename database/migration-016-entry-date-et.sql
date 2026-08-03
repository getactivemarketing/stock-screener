-- Migration 016: portfolio_state.entry_date -> DATE (ET calendar date)
--
-- entry_date has always meant "the ET calendar date this holding period began",
-- but it was declared TIMESTAMPTZ and written as a UTC date-only string. Postgres
-- stored that as midnight UTC, which is 20:00 ET the PREVIOUS day. Every ET-date
-- comparison therefore reported a position as having been opened a day earlier
-- than it was, which made the no-same-day-sell gate unreachable: 195 same-day
-- round trips across 60 tickers on 29 trading days while the flag was enabled.
--
-- A DATE column carries no timezone, so the value can no longer drift when the
-- session TimeZone or the client driver changes.
--
-- Conversion is exact: every existing row is stored at exactly midnight UTC
-- (verified: 1936/1936 rows, 0 with a non-zero time component), and all were
-- written during US market hours when the UTC date equals the ET date. Pinning
-- the cast to UTC therefore recovers the date string originally written.
-- Idempotent: re-running is a no-op once the column is already DATE.

BEGIN;

ALTER TABLE portfolio_state
  ALTER COLUMN entry_date TYPE DATE
  USING (entry_date AT TIME ZONE 'UTC')::date;

COMMENT ON COLUMN portfolio_state.entry_date IS
  'America/New_York calendar date the current holding period began. Reset on '
  're-entry after the position goes flat. Read as text (to_char) so no client '
  'driver reinterprets it in another timezone.';

COMMIT;
