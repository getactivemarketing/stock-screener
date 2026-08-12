import { isWorkingOrderStatus } from './open-orders.js';
import type { AlpacaOrder, AlpacaPosition } from '../types/index.js';

/**
 * A slot of capital the account has committed: either a real position or a buy
 * order that is working and expected to become one.
 *
 * Deliberately structural rather than an AlpacaPosition, so validateBuy can take
 * the union of real and pending exposure without caring which is which.
 */
export interface Commitment {
  ticker: string;
  marketValue: number;
}

/**
 * The portfolio as the risk checks should see it: everything already held, plus
 * everything already ordered.
 *
 * validateBuy() enforces max_positions, the duplicate-holding rule and portfolio
 * heat against the Alpaca POSITIONS array. That array is captured once per cycle,
 * so an order placed in an earlier cycle and not yet filled is invisible to it,
 * and every candidate in a cycle validates as though it were the only one.
 *
 * On 2026-08-07 the bot held 2 positions and queued 8 orders across three cycles
 * — five in the 20:38 cycle alone, each sized at ~10% of equity as though the
 * other four did not exist. All 8 filled at Monday's open, leaving 10 positions
 * and 99% heat against a configured max of 5 positions and 40% heat. The limit
 * had already been breached on 12 of the 26 trading days since 2026-07-06.
 *
 * An order that cannot be priced is still included, at zero value. It does not
 * contribute to heat, but it holds a slot and blocks a duplicate — under-counting
 * one order's value is a smaller error than treating its ticker as uncommitted.
 */
export function buildCommitted(
  positions: AlpacaPosition[],
  openOrders: AlpacaOrder[],
  lastPrices: Record<string, number> = {}
): Commitment[] {
  // Absolute value, because heat means exposure and a short is exposure. Alpaca
  // reports market_value negative for shorts, so passing it through would make a
  // short SUBTRACT from measured heat and hand the bot headroom on the very cap
  // meant to prevent over-exposure. No-op for longs. See long-only-guard.ts.
  const committed: Commitment[] = positions.map((p) => ({
    ticker: p.ticker,
    marketValue: Math.abs(p.marketValue),
  }));
  const seen = new Set(committed.map((c) => c.ticker.toUpperCase()));

  for (const o of openOrders) {
    if (o.side !== 'buy') continue;
    if (!isWorkingOrderStatus(o.status)) continue;
    const ticker = o.ticker.trim().toUpperCase();
    // An add-on order for a ticker already held is not a second slot, and its
    // value is already inside the position's market value.
    if (seen.has(ticker)) continue;
    const price = o.limitPrice ?? lastPrices[ticker] ?? 0;
    committed.push({ ticker, marketValue: o.quantity * price });
    seen.add(ticker);
  }

  return committed;
}

/**
 * Record a buy approved earlier in this cycle so later candidates see it.
 *
 * Without this, the five buys approved in a single cycle each read the same
 * frozen snapshot and none of them counted the others.
 */
export function addCommitment(
  committed: Commitment[],
  ticker: string,
  orderValue: number
): Commitment[] {
  const key = ticker.trim().toUpperCase();
  if (committed.some((c) => c.ticker.toUpperCase() === key)) return committed;
  return [...committed, { ticker: key, marketValue: orderValue }];
}
