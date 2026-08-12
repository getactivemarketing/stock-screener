import { describe, it, expect } from 'vitest';
import { soldTodayTickers } from './day-trade-guard';
import type { AlpacaOrder } from '../types/index.js';

const order = (o: Partial<AlpacaOrder>): AlpacaOrder => ({
  id: 'x',
  ticker: 'AAA',
  side: 'sell',
  quantity: 1,
  type: 'market',
  status: 'filled',
  filledAvgPrice: 100,
  filledAt: '2026-08-11T13:34:53Z',
  createdAt: '2026-08-10T22:09:00Z',
  limitPrice: null,
  ...o,
});

/**
 * Regression tests for the sell-then-rebuy day trade.
 *
 * The overnight-hold rule constrains SELLS: a position bought today cannot be
 * sold today. It says nothing about the mirror image — re-entering a ticker
 * that was SOLD today. FINRA counts both: a day trade is "purchasing and
 * selling, or SELLING AND PURCHASING, the same security on the same day."
 *
 * Observed live on 2026-08-11: NVDA's sell was decided Monday 18:09 on shares
 * held since 08-07 — entirely legitimate — but filled at Tuesday's 09:34 open.
 * At 10:46 the bot bought NVDA again. Buy and sell on the same date; a day
 * trade, arrived at without either individual decision being wrong.
 *
 * Rare but not zero: 2 of the 16 same-day pairs since 2026-08-03 were this
 * shape (SNDK 08-04, NVDA 08-11); the other 14 were the buy-then-sell leak
 * already closed. The requirement is zero.
 */
describe('soldTodayTickers', () => {
  const todayEt = '2026-08-11';

  it('blocks a ticker whose sell filled today', () => {
    expect(soldTodayTickers([order({ ticker: 'NVDA' })], todayEt)).toEqual(new Set(['NVDA']));
  });

  it('the NVDA case: sell DECIDED yesterday, FILLED today, still counts', () => {
    // The order was created Monday evening; only the fill date matters, because
    // the fill is what lands on the day-trade ledger.
    expect(soldTodayTickers([
      order({ ticker: 'NVDA', createdAt: '2026-08-10T22:09:00Z', filledAt: '2026-08-11T13:34:53Z' }),
    ], todayEt)).toEqual(new Set(['NVDA']));
  });

  it('ignores a sell that filled on a previous day', () => {
    expect(soldTodayTickers([
      order({ ticker: 'OLD', filledAt: '2026-08-10T14:10:00Z' }),
    ], todayEt)).toEqual(new Set());
  });

  it('uses the ET calendar date, not UTC', () => {
    // 2026-08-11T00:30:00Z is 2026-08-10 20:30 ET — the PREVIOUS trading day.
    // Counting it as today would block a legitimate entry; counting a 2026-08-12
    // 01:00Z fill as tomorrow would MISS a real same-day pair.
    expect(soldTodayTickers([
      order({ ticker: 'EVE', filledAt: '2026-08-11T00:30:00Z' }),
    ], todayEt)).toEqual(new Set());
    expect(soldTodayTickers([
      order({ ticker: 'LATE', filledAt: '2026-08-12T01:00:00Z' }),
    ], '2026-08-11')).toEqual(new Set(['LATE']));
  });

  it('ignores buy orders', () => {
    expect(soldTodayTickers([order({ ticker: 'NVDA', side: 'buy' })], todayEt)).toEqual(new Set());
  });

  it('ignores sells that never filled', () => {
    expect(soldTodayTickers([
      order({ ticker: 'CANC', status: 'canceled', filledAt: null }),
      order({ ticker: 'WORK', status: 'accepted', filledAt: null }),
    ], todayEt)).toEqual(new Set());
  });

  it('counts a partial fill — shares did change hands today', () => {
    expect(soldTodayTickers([
      order({ ticker: 'PART', status: 'partially_filled' }),
    ], todayEt)).toEqual(new Set(['PART']));
  });

  it('ignores a filled sell with no fill timestamp rather than guessing', () => {
    expect(soldTodayTickers([
      order({ ticker: 'NOTS', status: 'filled', filledAt: null }),
    ], todayEt)).toEqual(new Set());
  });

  it('upper-cases and trims to match Alpaca symbols', () => {
    expect(soldTodayTickers([order({ ticker: ' nvda ' })], todayEt)).toEqual(new Set(['NVDA']));
  });

  it('dedupes multiple sell fills of the same ticker', () => {
    expect(soldTodayTickers([
      order({ ticker: 'SNDK', id: '1', filledAt: '2026-08-11T14:00:00Z' }),
      order({ ticker: 'SNDK', id: '2', filledAt: '2026-08-11T15:00:00Z' }),
    ], todayEt)).toEqual(new Set(['SNDK']));
  });

  it('the SNDK 2026-08-04 case', () => {
    // Sold 15:38 UTC, re-bought 16:40 UTC the same ET day.
    expect(soldTodayTickers([
      order({ ticker: 'SNDK', filledAt: '2026-08-04T15:38:07Z' }),
    ], '2026-08-04')).toEqual(new Set(['SNDK']));
  });

  it('empty book yields an empty set', () => {
    expect(soldTodayTickers([], todayEt)).toEqual(new Set());
  });
});
