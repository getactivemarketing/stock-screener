import db from '../db/index.js';
import * as alpaca from './alpaca.js';
import { etDateString } from './trade-restrictions.js';
import type { AlpacaOrder } from '../types/index.js';

/** Sell states in which shares actually changed hands. */
const FILLED_STATUSES = new Set(['filled', 'partially_filled']);

/**
 * Tickers whose SELL filled today, in ET.
 *
 * The overnight-hold rule constrains sells: a position bought today cannot be
 * sold today. It says nothing about the mirror image — re-entering a ticker
 * sold today. FINRA counts both directions: a day trade is "purchasing and
 * selling, or selling and purchasing, the same security on the same day."
 *
 * NVDA on 2026-08-11 arrived at a day trade without either decision being
 * wrong: the sell was decided Monday evening on shares held since 08-07, filled
 * at Tuesday's open, and the bot re-bought at 10:46. Only the FILL date matters
 * here, because the fill is what lands on the day-trade ledger — an order
 * created yesterday and filled today counts as today.
 *
 * Unlike the working-order check, an unknown status is NOT treated as filled: a
 * sell that never executed did not consume a day trade, and blocking on it would
 * forfeit entries for no protection. The status set is therefore explicit.
 */
export function soldTodayTickers(orders: AlpacaOrder[], todayEt: string): Set<string> {
  const sold = new Set<string>();
  for (const o of orders) {
    if (o.side !== 'sell') continue;
    if (!FILLED_STATUSES.has((o.status ?? '').trim().toLowerCase())) continue;
    // No fill timestamp means we cannot place it on a calendar day. Skip rather
    // than guess: createdAt can precede the fill by a whole session.
    if (!o.filledAt) continue;
    const filled = new Date(o.filledAt);
    if (Number.isNaN(filled.getTime())) continue;
    if (etDateString(filled) !== todayEt) continue;
    sold.add(o.ticker.trim().toUpperCase());
  }
  return sold;
}

/**
 * Load the set of tickers sold today, so the buy loop will not re-enter them.
 *
 * Unions Alpaca's closed orders with the trades ledger. The two fail in
 * different ways — Alpaca's closed-order window can truncate, and a trades row
 * stays 'pending' until reconciliation catches it — and the cost is heavily
 * asymmetric: a missed ticker books a day trade, a spurious one forfeits a
 * single entry until tomorrow. So both are consulted and the union wins.
 *
 * Returns an empty set only if BOTH sources fail, which is logged.
 */
export async function fetchSoldTodayTickers(todayEt: string): Promise<Set<string>> {
  const sold = new Set<string>();
  let anySucceeded = false;

  try {
    for (const t of soldTodayTickers(await alpaca.getOrders('closed', 500), todayEt)) {
      sold.add(t);
    }
    anySucceeded = true;
  } catch (err) {
    console.error('[Trader] Could not load closed orders for the day-trade guard:', err);
  }

  try {
    const rows = await db.query<{ ticker: string }>(
      `SELECT DISTINCT ticker
         FROM trades
        WHERE action = 'SELL'
          AND status IN ('filled', 'partial')
          AND filled_at IS NOT NULL
          AND to_char(filled_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') = $1`,
      [todayEt]
    );
    for (const r of rows) sold.add(r.ticker.trim().toUpperCase());
    anySucceeded = true;
  } catch (err) {
    console.error('[Trader] Day-trade guard DB lookup failed:', err);
  }

  if (!anySucceeded) {
    console.error('[Trader] Day-trade guard has NO source of truth this cycle; re-entries unguarded.');
  }
  return sold;
}
