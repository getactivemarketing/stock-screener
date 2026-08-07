import db from '../db/index.js';

/**
 * Order states that mean an entry order can never hold shares again. Anything
 * else — filled, partially filled, still working, or a state we do not
 * recognise — leaves the ticker research-owned.
 */
const DEAD_ORDER_STATUSES = new Set([
  'canceled',
  'cancelled',
  'expired',
  'rejected',
  'replaced',
  'suspended',
  'stopped',
]);

/**
 * True when an entry order in this state might still be holding, or be about to
 * hold, shares.
 *
 * Unknown states deliberately return true. Alpaca can add order states, and the
 * cost of the two mistakes is wildly asymmetric: skipping a sell we could have
 * made is recoverable on the next 30-minute cycle, whereas liquidating a
 * position the bot did not open destroys a thesis the user staged by hand.
 */
export function isResearchOwnedStatus(status: string | null | undefined): boolean {
  if (!status) return true;
  return !DEAD_ORDER_STATUSES.has(status.trim().toLowerCase());
}

/** Tickers whose research entry orders may still hold shares. Upper-cased to match Alpaca symbols. */
export function researchOwnedTickers(
  rows: Array<{ ticker: string; status: string | null }>
): Set<string> {
  const owned = new Set<string>();
  for (const row of rows) {
    if (isResearchOwnedStatus(row.status)) owned.add(row.ticker.trim().toUpperCase());
  }
  return owned;
}

/**
 * Load the set of tickers the auto-trader must not sell because a Screen 2
 * research entry owns them.
 *
 * Screen 2 stages GTC limit buys onto the SAME Alpaca paper account the bot
 * trades, so a filled research entry is indistinguishable from a bot position
 * at the Alpaca API. Without this the bot applies its own stop-loss and
 * max-hold rules to them and exits positions it never opened.
 *
 * Note this intentionally does NOT affect risk sizing: max-positions, portfolio
 * heat and the duplicate-holding check all still count these positions, because
 * that capital really is deployed and at risk. The bot simply may not exit them.
 *
 * Fails open (empty set) on a DB error so a research-table problem cannot wedge
 * the trader's exit path entirely.
 */
export async function fetchResearchOwnedTickers(): Promise<Set<string>> {
  try {
    const rows = await db.query<{ ticker: string; status: string | null }>(
      `SELECT p.ticker, o.status
       FROM entry_orders o
       JOIN entry_plans p ON p.id = o.entry_plan_id`
    );
    return researchOwnedTickers(rows);
  } catch (err) {
    console.error('[Trader] Could not load research-owned tickers:', err);
    return new Set();
  }
}
