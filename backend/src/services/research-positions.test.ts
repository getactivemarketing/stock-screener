import { describe, it, expect } from 'vitest';
import { isResearchOwnedStatus, researchOwnedTickers } from './research-positions';

/**
 * The auto-trader evaluates a SELL on every open Alpaca position. Research
 * entries staged by Screen 2 land in that same paper account, so without a
 * provenance filter the bot applies its own stop-loss / max-hold rules to
 * positions it did not open and liquidates them.
 *
 * A ticker is "research-owned" whenever an entry order might still be holding
 * or about to hold shares. The bias is deliberately conservative: an order in
 * an unknown or in-flight state counts as owned, because wrongly skipping a
 * sell is recoverable and wrongly selling someone's thesis is not.
 */
describe('isResearchOwnedStatus', () => {
  it('counts filled orders — shares are held', () => {
    expect(isResearchOwnedStatus('filled')).toBe(true);
    expect(isResearchOwnedStatus('partially_filled')).toBe(true);
  });

  it('counts open orders that have not filled yet', () => {
    // A GTC limit buy can fill between two cron runs, so the bot must already
    // be treating the ticker as hands-off before the fill lands.
    expect(isResearchOwnedStatus('new')).toBe(true);
    expect(isResearchOwnedStatus('pending')).toBe(true);
    expect(isResearchOwnedStatus('accepted')).toBe(true);
  });

  it('releases terminally dead orders', () => {
    expect(isResearchOwnedStatus('canceled')).toBe(false);
    expect(isResearchOwnedStatus('cancelled')).toBe(false); // both spellings
    expect(isResearchOwnedStatus('expired')).toBe(false);
    expect(isResearchOwnedStatus('rejected')).toBe(false);
  });

  it('is case-insensitive and tolerates padding', () => {
    expect(isResearchOwnedStatus('  CANCELED ')).toBe(false);
    expect(isResearchOwnedStatus('Filled')).toBe(true);
  });

  it('treats unknown or empty status as owned, erring away from selling', () => {
    expect(isResearchOwnedStatus('some_new_alpaca_state')).toBe(true);
    expect(isResearchOwnedStatus('')).toBe(true);
    expect(isResearchOwnedStatus(null)).toBe(true);
  });
});

describe('researchOwnedTickers', () => {
  it('collects tickers holding or awaiting shares', () => {
    const set = researchOwnedTickers([
      { ticker: 'AAPL', status: 'filled' },
      { ticker: 'MSFT', status: 'new' },
      { ticker: 'NVDA', status: 'canceled' },
    ]);
    expect(set.has('AAPL')).toBe(true);
    expect(set.has('MSFT')).toBe(true);
    expect(set.has('NVDA')).toBe(false);
  });

  it('keeps a ticker owned when any one of its orders is still live', () => {
    // A partly cancelled plan still holds the shares that already filled.
    const set = researchOwnedTickers([
      { ticker: 'AAPL', status: 'canceled' },
      { ticker: 'AAPL', status: 'filled' },
      { ticker: 'AAPL', status: 'canceled' },
    ]);
    expect(set.has('AAPL')).toBe(true);
  });

  it('normalises ticker case so lookups match Alpaca symbols', () => {
    const set = researchOwnedTickers([{ ticker: 'aapl', status: 'filled' }]);
    expect(set.has('AAPL')).toBe(true);
  });

  it('returns an empty set for no orders', () => {
    expect(researchOwnedTickers([]).size).toBe(0);
  });
});
