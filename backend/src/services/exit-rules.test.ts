import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { AlpacaPosition, TradingConfig } from '../types/index.js';

const queryMock = vi.fn();
vi.mock('../db/index.js', () => ({
  default: { query: (...args: unknown[]) => queryMock(...args) },
}));
vi.mock('./alpaca.js', () => ({
  getOrders: vi.fn(async () => []),
  getPositions: vi.fn(async () => []),
}));

const { evaluateSell } = await import('./trader-unified.js');

/**
 * Regression tests for the scan-miss churn engine.
 *
 * `scan_miss` exits a position that has been absent from the screener's scan
 * for `scan_miss_max` consecutive cycles (3, on a 30-minute cron — so ninety
 * minutes off the list). The scan is a capacity-limited ranking of ~18 tickers
 * ordered by social attention, NOT a verdict on the position. A holding drops
 * off it when eighteen other tickers are noisier, which is not information
 * about the holding.
 *
 * Measured 2026-08-12, exits since the entry_date fix landed on 2026-08-03:
 *   scan_miss 22 | reclass_avoid 12 | max_hold 3 | pre_earnings 2 | catalyst_fade 2
 * scan_miss was 54% of all exits, and 36% of them were re-bought within 5 days.
 *
 * Watched live: APP left and rejoined the scan four times in one session; three
 * consecutive absences sold it at 10:10, and it was back on the list at 14:39
 * with the buy logic asking for it seven more times. NVDA exited on scan_miss
 * with entry_composite 39 -> exit_composite 45: its own score had gone UP.
 *
 * Absence is not a sell signal. The backstops below are what bound a position
 * instead, and they are asserted here so removing scan_miss cannot create an
 * immortal holding.
 */

const CONFIG = {
  holdDaysMax: 5,
  qualityHoldDaysMax: 15,
  scanMissMax: 3,
  speculativeMaxHoldDays: 3,
  speculativeStopLossPct: 8,
  preEarningsExitDays: 1,
  noSameDaySell: true,
} as unknown as TradingConfig;

const position = (o: Partial<AlpacaPosition> = {}): AlpacaPosition =>
  ({
    ticker: 'APP',
    quantity: 35,
    avgEntryPrice: 300,
    marketValue: 11_000,
    currentPrice: 314,
    unrealizedPl: 500,
    unrealizedPlPct: 4.6,
    side: 'long',
    ...o,
  }) as AlpacaPosition;

/** portfolio_state row, then the most-recent-filled-BUY row. */
function primeDb(state: Record<string, unknown>, buyEtDate = '2026-07-01') {
  queryMock.mockReset();
  queryMock
    .mockResolvedValueOnce([
      {
        days_held: 2,
        consecutive_scan_misses: 0,
        entry_date: '2026-07-01',
        quantity: 35,
        entry_category: 'earnings_event',
        entry_catalyst_date: null,
        ...state,
      },
    ])
    .mockResolvedValue([{ buy_et_date: buyEtDate }]);
}

beforeEach(() => queryMock.mockReset());

describe('scan-miss is not an exit signal', () => {
  it('HOLDS a position that has been absent from the scan far past the limit', () => {
    primeDb({ consecutive_scan_misses: 99 });
    return expect(
      evaluateSell(position(), null, CONFIG, 'core').then((d) => d.action)
    ).resolves.toBe('HOLD');
  });

  it('does not label any decision scan_miss', async () => {
    primeDb({ consecutive_scan_misses: 99 });
    const d = (await evaluateSell(position(), null, CONFIG, 'core')) as { exitReason?: string };
    expect(d.exitReason).not.toBe('scan_miss');
  });
});

describe('the backstops still bound an absent position', () => {
  it('stop-loss still fires while the ticker is off the scan', async () => {
    primeDb({ consecutive_scan_misses: 99 });
    const d = (await evaluateSell(
      position({ unrealizedPlPct: -20 }),
      null,
      CONFIG,
      'core'
    )) as { action: string; exitReason?: string };
    expect(d.action).toBe('SELL');
    expect(d.exitReason).toBe('stop_loss');
  });

  it('max_hold still fires while the ticker is off the scan', async () => {
    // earnings_event caps at 12 days.
    primeDb({ consecutive_scan_misses: 99, days_held: 40 });
    const d = (await evaluateSell(position(), null, CONFIG, 'core')) as {
      action: string;
      exitReason?: string;
    };
    expect(d.action).toBe('SELL');
    expect(d.exitReason).toBe('max_hold');
  });
});
