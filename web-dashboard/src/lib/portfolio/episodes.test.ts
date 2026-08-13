import { describe, it, expect } from 'vitest';
import { buildEpisodes, etDateString, type TradeRow } from './episodes';

const buy = (ticker: string, qty: number, price: number, at: string): TradeRow => ({
  ticker, action: 'BUY', quantity: qty, filledPrice: price, filledAt: at,
  classification: 'runner', rationale: 'test thesis',
});
const sell = (ticker: string, qty: number, price: number, at: string): TradeRow => ({
  ticker, action: 'SELL', quantity: qty, filledPrice: price, filledAt: at,
  classification: null, rationale: null,
});

describe('etDateString', () => {
  it('converts an instant to its America/New_York calendar date', () => {
    // 2026-08-06T13:30:00Z is 09:30 ET the same day.
    expect(etDateString('2026-08-06T13:30:00Z')).toBe('2026-08-06');
  });

  it('rolls back to the previous ET date for a late-UTC instant', () => {
    // 2026-08-07T01:00:00Z is 21:00 ET on 2026-08-06. Using the UTC date here
    // is the class of bug that hid the same-day-sell gate failure for 5 weeks.
    expect(etDateString('2026-08-07T01:00:00Z')).toBe('2026-08-06');
  });
});

describe('buildEpisodes', () => {
  it('pairs one buy and one sell into a single closed episode', () => {
    const { episodes } = buildEpisodes([
      buy('AAA', 10, 100, '2026-08-03T14:00:00Z'),
      sell('AAA', 10, 110, '2026-08-05T14:00:00Z'),
    ]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].isOpen).toBe(false);
    expect(episodes[0].totalCost).toBe(1000);
    expect(episodes[0].totalProceeds).toBe(1100);
    expect(episodes[0].realizedPl).toBe(100);
    expect(episodes[0].realizedPlPct).toBeCloseTo(10, 6);
    expect(episodes[0].holdDays).toBe(2);
  });

  it('keeps a partial sell and a top-up inside ONE episode until flat', () => {
    // The decision the bot made was "be in AAA from the 3rd to the 7th".
    // FIFO lot matching would split this into rows matching no such decision.
    const { episodes } = buildEpisodes([
      buy('AAA', 10, 100, '2026-08-03T14:00:00Z'),
      sell('AAA', 4, 105, '2026-08-04T14:00:00Z'),
      buy('AAA', 4, 102, '2026-08-05T14:00:00Z'),
      sell('AAA', 10, 108, '2026-08-07T14:00:00Z'),
    ]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].peakQuantity).toBe(10);
    expect(episodes[0].totalCost).toBe(10 * 100 + 4 * 102);
    expect(episodes[0].totalProceeds).toBe(4 * 105 + 10 * 108);
  });

  it('splits a re-entry into a second episode that is still open', () => {
    const { episodes } = buildEpisodes([
      buy('AAA', 10, 100, '2026-08-03T14:00:00Z'),
      sell('AAA', 10, 110, '2026-08-04T14:00:00Z'),
      buy('AAA', 5, 120, '2026-08-06T14:00:00Z'),
    ]);
    expect(episodes).toHaveLength(2);
    // Episodes come back NEWEST FIRST, which is how the History tab renders them.
    // `index` stays chronological per ticker, so the newer episode is index 1.
    expect(episodes[0].isOpen).toBe(true);
    expect(episodes[0].index).toBe(1);
    expect(episodes[1].isOpen).toBe(false);
    expect(episodes[1].index).toBe(0);
  });

  it('reports an OPEN episode as realizedPl null, never zero', () => {
    // Zero would assert it broke even. Null says "not yet known".
    const { episodes } = buildEpisodes([buy('AAA', 10, 100, '2026-08-03T14:00:00Z')]);
    expect(episodes[0].realizedPl).toBeNull();
    expect(episodes[0].realizedPlPct).toBeNull();
    expect(episodes[0].closedAt).toBeNull();
    expect(episodes[0].holdDays).toBeNull();
  });

  it('flags an episode opened and closed on the same ET date', () => {
    const { episodes } = buildEpisodes([
      buy('AAA', 10, 100, '2026-08-06T13:30:00Z'),
      sell('AAA', 10, 101, '2026-08-06T14:10:00Z'),
    ]);
    expect(episodes[0].sameEtDay).toBe(true);
  });

  it('does NOT flag an overnight hold as same-day', () => {
    // Opened 21:00 ET on the 6th, closed 09:30 ET on the 7th. Comparing UTC
    // dates would call this same-day and manufacture a gate violation.
    const { episodes } = buildEpisodes([
      buy('AAA', 10, 100, '2026-08-07T01:00:00Z'),
      sell('AAA', 10, 101, '2026-08-07T13:30:00Z'),
    ]);
    expect(episodes[0].sameEtDay).toBe(false);
  });

  it('carries classification and rationale from the episode-opening buy', () => {
    const { episodes } = buildEpisodes([buy('AAA', 10, 100, '2026-08-03T14:00:00Z')]);
    expect(episodes[0].classificationAtEntry).toBe('runner');
    expect(episodes[0].rationaleAtEntry).toBe('test thesis');
  });

  it('keeps tickers independent and orders trades by fill time', () => {
    const { episodes } = buildEpisodes([
      sell('AAA', 10, 110, '2026-08-04T14:00:00Z'),  // deliberately out of order
      buy('BBB', 3, 50, '2026-08-03T14:00:00Z'),
      buy('AAA', 10, 100, '2026-08-03T14:00:00Z'),
    ]);
    expect(episodes.filter((e) => e.ticker === 'AAA')).toHaveLength(1);
    expect(episodes.filter((e) => e.ticker === 'BBB')).toHaveLength(1);
    expect(episodes.find((e) => e.ticker === 'AAA')!.isOpen).toBe(false);
  });

  it('SURFACES a ledger that would go negative instead of swallowing it', () => {
    // Selling more than was bought means the ledger disagrees with reality.
    // Clamping or dropping it silently would hide a real data problem.
    const { episodes, anomalies } = buildEpisodes([sell('AAA', 5, 100, '2026-08-03T14:00:00Z')]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toContain('AAA');
    expect(episodes.filter((e) => e.ticker === 'AAA')).toHaveLength(0);
  });

  it('returns empty for no trades rather than throwing', () => {
    expect(buildEpisodes([])).toEqual({ episodes: [], anomalies: [] });
  });
});
