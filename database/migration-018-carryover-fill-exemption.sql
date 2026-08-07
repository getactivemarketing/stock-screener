-- Migration 018: opt-in exemption for carried-over fills in the same-day-sell gate.
--
-- The bot places GTC limit orders in one session that frequently do not fill
-- until the next session's open. The strict gate starts the holding period at
-- the FILL, so those positions cannot be exited on the day they fill even though
-- the decision to buy was made a session earlier.
--
-- With this flag on, the holding period starts at the session the buy order was
-- PLACED. A genuine intraday flip (placed, filled and sold in one session) is
-- still blocked.
--
-- Defaults to FALSE, i.e. no behaviour change on deploy. Flip it in the DB to
-- A/B the two rules without a redeploy:
--   UPDATE trading_config SET same_day_sell_exempts_carryover_fills = TRUE;
--
-- CAUTION: under PDT rules a buy and a sell on the same calendar date is a day
-- trade regardless of when the order was placed. Only enable this while the
-- account is exempt from PDT (paper, or equity above the threshold).

ALTER TABLE trading_config
  ADD COLUMN IF NOT EXISTS same_day_sell_exempts_carryover_fills BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN trading_config.same_day_sell_exempts_carryover_fills IS
  'When true, a position whose latest buy order was placed in an earlier session is not treated as entered today by the no_same_day_sell gate.';
