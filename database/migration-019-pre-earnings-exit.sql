-- Migration 019: pre-earnings exit window.
--
-- The bot may not sell a position on the day it bought it (the overnight-hold
-- rule), so it cannot react to an earnings print: a bad number gaps 15-25%
-- overnight, well past the -12% stop, and the stop cannot fire because the move
-- happens while the market is closed. No intraday stop-loss carve-out helps.
--
-- Meanwhile the catalyst score awards its LARGEST single bonus (+30, on a
-- component worth 35% of composite) for earnings within 5 days — it was
-- steering into the one event it structurally cannot manage. Historically 70 of
-- 198 earnings_event entries, 35%, were opened within 5 days of the print.
--
-- So schedule the exit instead of abandoning the trade: hold the run-up into
-- earnings, close out before the print. This one value drives BOTH halves:
--   * EXIT  an earnings_event position when days-to-print <= N
--   * BLOCK opening one inside the same window, because a position bought today
--     cannot be sold until tomorrow — if the print is tomorrow there is no
--     session in which the exit rule could act.
-- Sharing the number means the two cannot drift apart and leave a gap where an
-- entry is admitted that the exit can never rescue.
--
-- 0 disables both halves. Ships as 0 so deploying changes nothing; set it to 1
-- to enable:
--   UPDATE trading_config SET pre_earnings_exit_days = 1;
--
-- Widening it (2, 3) exits earlier and admits fewer pre-earnings entries. Note
-- entry_catalyst_date is captured at ENTRY and earnings dates do move; a stale
-- date is a known limitation of this version.

ALTER TABLE trading_config
  ADD COLUMN IF NOT EXISTS pre_earnings_exit_days INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN trading_config.pre_earnings_exit_days IS
  'Exit an earnings_event position when days-to-print <= this, and refuse to open one inside the same window. 0 disables.';
