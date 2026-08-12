import { describe, it, expect } from 'vitest';
import { isLongPosition, partitionByDirection } from './long-only-guard';
import type { AlpacaPosition } from '../types/index.js';

const pos = (o: Partial<AlpacaPosition>): AlpacaPosition =>
  ({
    ticker: 'AAA',
    quantity: 100,
    avgEntryPrice: 10,
    marketValue: 1_000,
    currentPrice: 10,
    unrealizedPl: 0,
    unrealizedPlPct: 0,
    side: 'long',
    ...o,
  }) as AlpacaPosition;

/**
 * The bot is long-only by ASSUMPTION, not by construction.
 *
 * AlpacaPosition.side is parsed at alpaca.ts:141 and read nowhere. Every `.side`
 * access in the codebase is on an ORDER (open-orders, committed-portfolio,
 * day-trade-guard); not one is on a position. A short position would therefore
 * flow through the whole pipeline dressed as a long.
 *
 * The expensive consequence is in risk.ts:59, which sums marketValue to measure
 * portfolio heat. Alpaca reports market_value NEGATIVE for a short, so a short
 * would SUBTRACT from measured exposure: open a $10k short and the heat cap
 * silently grants $10k of extra headroom. The 85% cap would stop being a cap.
 *
 * No short has ever existed in this account. One could arrive from a manual
 * trade in the Alpaca dashboard or a sell that overshot held quantity. The guard
 * exists so that arrival is loud and inert instead of quiet and corrupting.
 */
describe('isLongPosition', () => {
  it('accepts an ordinary long', () => {
    expect(isLongPosition(pos({}))).toBe(true);
  });

  it('rejects an explicit short', () => {
    expect(isLongPosition(pos({ side: 'short', quantity: -100, marketValue: -1_000 }))).toBe(false);
  });

  it('rejects on negative quantity even when side claims long', () => {
    // The numbers are the ground truth. If they disagree with the label,
    // something is wrong enough that the position should not be traded.
    expect(isLongPosition(pos({ side: 'long', quantity: -100 }))).toBe(false);
  });

  it('rejects on negative market value even when side claims long', () => {
    expect(isLongPosition(pos({ side: 'long', marketValue: -1_000 }))).toBe(false);
  });

  it('rejects a zero-quantity position', () => {
    // Nothing to sell, so quarantining costs nothing and the anomaly gets logged.
    expect(isLongPosition(pos({ quantity: 0 }))).toBe(false);
  });

  it('treats a MISSING side with sane numbers as long, not as an anomaly', () => {
    // Deliberate asymmetry. Quarantining a real long is worse than admitting an
    // unlabelled one: a quarantined position stops being managed, which means no
    // stop-loss and no max-hold exit on a live holding. A parsing gap in one
    // string field must not strand real money.
    expect(isLongPosition(pos({ side: undefined as unknown as string }))).toBe(true);
    expect(isLongPosition(pos({ side: '' }))).toBe(true);
  });

  it('tolerates casing and whitespace on the side label', () => {
    expect(isLongPosition(pos({ side: 'LONG' }))).toBe(true);
    expect(isLongPosition(pos({ side: ' long ' }))).toBe(true);
  });

  it('rejects an unrecognised side label', () => {
    // Not 'long' and not absent means Alpaca is telling us something we do not
    // model. Refuse to trade it rather than guess.
    expect(isLongPosition(pos({ side: 'net' }))).toBe(false);
  });
});

describe('partitionByDirection', () => {
  it('splits longs from everything else, preserving order', () => {
    const a = pos({ ticker: 'AAA' });
    const b = pos({ ticker: 'BBB', side: 'short', quantity: -5, marketValue: -500 });
    const c = pos({ ticker: 'CCC' });

    expect(partitionByDirection([a, b, c])).toEqual({ longs: [a, c], nonLong: [b] });
  });

  it('reports no anomaly for an all-long book', () => {
    expect(partitionByDirection([pos({ ticker: 'AAA' }), pos({ ticker: 'BBB' })]).nonLong).toEqual([]);
  });

  it('handles an empty book', () => {
    expect(partitionByDirection([])).toEqual({ longs: [], nonLong: [] });
  });
});
