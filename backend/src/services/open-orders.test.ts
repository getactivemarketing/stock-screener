import { describe, it, expect } from 'vitest';
import { isWorkingOrderStatus, pendingBuyTickers } from './open-orders';
import type { AlpacaOrder } from '../types/index.js';

const order = (o: Partial<AlpacaOrder>): AlpacaOrder => ({
  id: 'x',
  ticker: 'AAA',
  side: 'buy',
  quantity: 1,
  type: 'market',
  status: 'accepted',
  filledAvgPrice: null,
  filledAt: null,
  createdAt: '2026-08-07T20:11:15Z',
  limitPrice: null,
  ...o,
});

describe('isWorkingOrderStatus', () => {
  it('treats live states as working', () => {
    for (const s of ['new', 'accepted', 'pending_new', 'partially_filled', 'held']) {
      expect(isWorkingOrderStatus(s)).toBe(true);
    }
  });

  it('treats terminal states as done', () => {
    for (const s of ['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'replaced']) {
      expect(isWorkingOrderStatus(s)).toBe(false);
    }
  });

  it('is case and whitespace insensitive', () => {
    expect(isWorkingOrderStatus(' Canceled ')).toBe(false);
    expect(isWorkingOrderStatus('ACCEPTED')).toBe(true);
  });

  it('treats an unknown state as working', () => {
    // Same asymmetry as isResearchOwnedStatus: skipping a buy costs one cycle,
    // double-sizing a position costs real money.
    expect(isWorkingOrderStatus('some_new_alpaca_state')).toBe(true);
    expect(isWorkingOrderStatus(null)).toBe(true);
    expect(isWorkingOrderStatus(undefined)).toBe(true);
  });
});

/**
 * Regression tests for the duplicate-order defect.
 *
 * evaluate() built its held-ticker set from Alpaca POSITIONS only, so an order
 * that was placed but had not filled did not stop the next cycle from placing
 * the same order again. Orders queued outside session hours stay pending across
 * every remaining cycle, so the window is wide open every evening.
 *
 * Observed live on 2026-08-07: SOUN 1440 placed 20:11 and again at 20:38, ONDS
 * 1268 placed 20:39 and again at 21:10 — two names that would have opened at
 * double the intended size at Monday's open. Cancelled by hand.
 */
describe('pendingBuyTickers', () => {
  it('collects tickers with a working buy order', () => {
    const set = pendingBuyTickers([
      order({ ticker: 'SOUN', status: 'accepted' }),
      order({ ticker: 'ONDS', status: 'new' }),
    ]);
    expect(set).toEqual(new Set(['SOUN', 'ONDS']));
  });

  it('the live 2026-08-07 book: every queued name blocks a repeat buy', () => {
    const book = ['WDC', 'SOUN', 'MP', 'DOCS', 'TTWO', 'MU', 'ONDS', 'INFQ'].map((t) =>
      order({ ticker: t, status: 'accepted' })
    );
    expect(pendingBuyTickers(book)).toEqual(
      new Set(['WDC', 'SOUN', 'MP', 'DOCS', 'TTWO', 'MU', 'ONDS', 'INFQ'])
    );
  });

  it('ignores sell orders', () => {
    // A pending SELL must not block anything: the position is still held, and
    // the held-position check already covers it.
    expect(pendingBuyTickers([order({ ticker: 'NVDA', side: 'sell' })])).toEqual(new Set());
  });

  it('ignores filled and cancelled orders', () => {
    expect(pendingBuyTickers([
      order({ ticker: 'AAA', status: 'filled' }),
      order({ ticker: 'BBB', status: 'canceled' }),
    ])).toEqual(new Set());
  });

  it('counts a partial fill as still working', () => {
    // Half a position is filled; re-placing the whole order would oversize it.
    expect(pendingBuyTickers([order({ ticker: 'MU', status: 'partially_filled' })]))
      .toEqual(new Set(['MU']));
  });

  it('upper-cases and trims to match Alpaca symbols', () => {
    expect(pendingBuyTickers([order({ ticker: ' soun ' })])).toEqual(new Set(['SOUN']));
  });

  it('dedupes the duplicate pair rather than double-counting', () => {
    expect(pendingBuyTickers([
      order({ ticker: 'SOUN', id: '1', createdAt: '2026-08-07T20:11:15Z' }),
      order({ ticker: 'SOUN', id: '2', createdAt: '2026-08-07T20:38:59Z' }),
    ])).toEqual(new Set(['SOUN']));
  });

  it('returns an empty set for an empty book', () => {
    expect(pendingBuyTickers([])).toEqual(new Set());
  });
});
