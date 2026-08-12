import type { AlpacaPosition } from '../types/index.js';

/**
 * Every strategy in this bot is long: the scoring pipeline produces an upside
 * composite, the exit rules read `unrealizedPlPct` as though down means losing,
 * and heat is the sum of market values. None of that survives a short position.
 *
 * The account has never held one. But `AlpacaPosition.side` is parsed at
 * alpaca.ts:141 and read NOWHERE — every `.side` access in the codebase is on an
 * order, never a position — so nothing would notice one arriving from a manual
 * dashboard trade or a sell that overshot held quantity. It would flow through
 * the pipeline dressed as a long, and Alpaca's NEGATIVE market_value for shorts
 * would subtract from the heat total in risk.ts:59, quietly handing the bot
 * extra headroom on the cap that exists to stop exactly that.
 *
 * This module makes the assumption explicit so the anomaly is loud and inert.
 */

/**
 * Whether a position is a plain long the rest of the pipeline can reason about.
 *
 * Three signals are checked, and any one of them can veto: the `side` label,
 * the sign of the quantity, and the sign of the market value. A short trips all
 * three; a partially-corrupt read trips one, and one is enough.
 *
 * The one deliberate asymmetry is a MISSING side label. Absent `side` with a
 * positive quantity and market value is treated as long, because the failure
 * costs are lopsided: a short misread as long corrupts the heat cap, but a real
 * long misread as an anomaly stops being managed entirely — no stop-loss, no
 * max-hold exit, on live money. A gap in one string field must not strand a
 * position. An unrecognised label is a different matter and is refused: that is
 * Alpaca describing something we do not model.
 */
export function isLongPosition(position: AlpacaPosition): boolean {
  const side = (position.side ?? '').trim().toLowerCase();
  if (side !== '' && side !== 'long') return false;
  if (!(position.quantity > 0)) return false;
  if (!(position.marketValue >= 0)) return false;
  return true;
}

/**
 * Split a book into the positions the bot may act on and the ones it must not.
 *
 * Callers are expected to keep `nonLong` OUT of the exit evaluation — the exit
 * rules are wrong for a short, so acting on one is worse than leaving it — while
 * still counting its exposure toward the risk limits. Order is preserved so
 * decision logs stay in book order.
 */
export function partitionByDirection(positions: AlpacaPosition[]): {
  longs: AlpacaPosition[];
  nonLong: AlpacaPosition[];
} {
  const longs: AlpacaPosition[] = [];
  const nonLong: AlpacaPosition[] = [];
  for (const p of positions) {
    (isLongPosition(p) ? longs : nonLong).push(p);
  }
  return { longs, nonLong };
}
