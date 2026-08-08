import db from '../db/index.js';
import * as alpaca from './alpaca.js';
import type { AlpacaOrder } from '../types/index.js';

/**
 * Order states that mean an order can never fill. Anything else — working,
 * partially filled, or a state we do not recognise — still counts as committed.
 */
const TERMINAL_ORDER_STATUSES = new Set([
  'filled',
  'canceled',
  'cancelled',
  'expired',
  'rejected',
  'replaced',
  'suspended',
  'stopped',
  'done_for_day',
]);

/**
 * True when an order might still fill.
 *
 * Unknown states deliberately return true, the same asymmetry used in
 * isResearchOwnedStatus: skipping a buy costs one 30-minute cycle, whereas
 * missing a working order opens the position at double the intended size.
 */
export function isWorkingOrderStatus(status: string | null | undefined): boolean {
  if (!status) return true;
  return !TERMINAL_ORDER_STATUSES.has(status.trim().toLowerCase());
}

/** Tickers with a buy order that may still fill. Upper-cased to match Alpaca symbols. */
export function pendingBuyTickers(orders: AlpacaOrder[]): Set<string> {
  const pending = new Set<string>();
  for (const o of orders) {
    if (o.side !== 'buy') continue;
    if (!isWorkingOrderStatus(o.status)) continue;
    pending.add(o.ticker.trim().toUpperCase());
  }
  return pending;
}

/**
 * Load the set of tickers that already have a buy order working, so the buy loop
 * does not place a second one.
 *
 * evaluate() derived "already held" from Alpaca POSITIONS alone. An order that
 * was placed but had not filled left no trace in that set, so the next cycle
 * re-evaluated the ticker from scratch and placed the same order again. Orders
 * queued outside session hours stay pending through every remaining cycle, which
 * is why 2026-08-07 ended with SOUN and ONDS each queued twice — both would have
 * opened at double size at Monday's open.
 *
 * Alpaca is the authority here rather than trades.status, because a pending row
 * that reconciliation never clears would block the ticker forever, whereas the
 * live order book is self-clearing. If that call fails we fall back to the DB's
 * pending BUY rows: a stale row costs a missed entry, an empty set costs a
 * double position.
 */
export async function fetchPendingBuyTickers(): Promise<Set<string>> {
  try {
    // 500 is Alpaca's per-page maximum; the default 50 could silently truncate
    // a long book and reopen exactly the gap this function exists to close.
    return pendingBuyTickers(await alpaca.getOrders('open', 500));
  } catch (err) {
    console.error('[Trader] Could not load open orders, falling back to DB:', err);
    try {
      const rows = await db.query<{ ticker: string }>(
        `SELECT DISTINCT ticker FROM trades WHERE action = 'BUY' AND status = 'pending'`
      );
      return new Set(rows.map((r) => r.ticker.trim().toUpperCase()));
    } catch (dbErr) {
      console.error('[Trader] Pending-buy fallback also failed:', dbErr);
      return new Set();
    }
  }
}
