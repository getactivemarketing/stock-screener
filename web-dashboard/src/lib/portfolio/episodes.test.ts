import { describe, it, expect } from 'vitest';
import {
  buildEpisodes, etDateString, summarizeClosed, behaviourStats, calendarDaysBetween,
  sameDayRegression, type TradeRow, type Episode,
} from './episodes';

const buy = (
  ticker: string,
  qty: number,
  price: number,
  at: string,
  classification = 'runner',
  rationale = 'test thesis'
): TradeRow => ({
  ticker, action: 'BUY', quantity: qty, filledPrice: price, filledAt: at,
  classification, rationale,
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

  it('surfaces mid-episode oversell (sell exceeds quantity while position open)', () => {
    // Bought 5 shares, trying to sell 10. This is a distinct anomaly path from
    // selling with no position at all. If the `running < 0` check were missing or
    // changed to `<= 0`, this would not be caught.
    const { episodes, anomalies } = buildEpisodes([
      buy('AAA', 5, 100, '2026-08-03T14:00:00Z'),
      sell('AAA', 10, 110, '2026-08-04T14:00:00Z'),  // oversell
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toContain('AAA');
    expect(episodes.filter((e) => e.ticker === 'AAA')).toHaveLength(0);
  });

  it('relies on caller pre-ordering for trades sharing an identical timestamp', () => {
    // Same filledAt for both rows. buildEpisodes sorts by timestamp alone, so
    // ties keep the CALLER's order (Array.prototype.sort is stable since
    // ES2019) -- the route supplies BUY-before-SELL via its own ORDER BY.
    // If a SELL landed ahead of its BUY here, it would be read as a sell
    // against no position and delete the ticker's whole history.
    const { episodes, anomalies } = buildEpisodes([
      buy('AAA', 10, 100, '2026-08-03T14:00:00Z'),
      sell('AAA', 10, 110, '2026-08-03T14:00:00Z'),
    ]);
    expect(anomalies).toHaveLength(0);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].isOpen).toBe(false);
    expect(episodes[0].realizedPl).toBe(100);
  });

  it('preserves classification/rationale from entry buy, not from later top-ups', () => {
    // Opens with 'runner', tops up with 'value'. classificationAtEntry and
    // rationaleAtEntry must stay frozen at the entry values. A regression that
    // overwrites them on every buy would pass the original 12 tests unchanged
    // (they all use identical values everywhere).
    const { episodes } = buildEpisodes([
      buy('AAA', 5, 100, '2026-08-03T14:00:00Z', 'runner', 'test thesis'),
      buy('AAA', 5, 105, '2026-08-04T14:00:00Z', 'value', 'top-up'),
      sell('AAA', 10, 110, '2026-08-05T14:00:00Z'),
    ]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].classificationAtEntry).toBe('runner');
    expect(episodes[0].rationaleAtEntry).toBe('test thesis');
  });
});

/** Minimal closed episode for summary tests. */
const closed = (o: Partial<Episode> & { ticker: string; realizedPl: number }): Episode => ({
  index: 0,
  openedAt: '2026-08-03T14:00:00Z',
  closedAt: '2026-08-05T14:00:00Z',
  openEtDate: '2026-08-03',
  closeEtDate: '2026-08-05',
  peakQuantity: 10,
  totalCost: 1000,
  totalProceeds: 1000 + o.realizedPl,
  realizedPlPct: (o.realizedPl / 1000) * 100,
  holdDays: 2,
  isOpen: false,
  sameEtDay: false,
  classificationAtEntry: null,
  rationaleAtEntry: null,
  ...o,
} as Episode);

describe('summarizeClosed', () => {
  it('totals realized P/L and counts wins and losses', () => {
    const s = summarizeClosed([
      closed({ ticker: 'AAA', realizedPl: 100 }),
      closed({ ticker: 'BBB', realizedPl: -40 }),
      closed({ ticker: 'CCC', realizedPl: 60 }),
    ]);
    expect(s.count).toBe(3);
    expect(s.realizedPl).toBe(120);
    expect(s.winCount).toBe(2);
    expect(s.lossCount).toBe(1);
    // winRatePct is win / (win + loss), not win / count.
    expect(s.winRatePct).toBeCloseTo(66.667, 2);
  });

  it('excludes an exactly-flat episode from wins, losses, AND the rate denominator', () => {
    // A flat trade is neither a win nor a loss. If it fell into `count` as the
    // rate denominator while landing in neither bucket, the displayed rate
    // would disagree with what a reader computes from the (W/L) caption --
    // this was observed in prod: 594 closed, 592 W+L, 50.7% shown vs 50.8%
    // implied by the caption.
    const s = summarizeClosed([
      closed({ ticker: 'AAA', realizedPl: 100 }),
      closed({ ticker: 'BBB', realizedPl: -100 }),
      closed({ ticker: 'CCC', realizedPl: 0 }),
    ]);
    expect(s.count).toBe(3);
    expect(s.winCount).toBe(1);
    expect(s.lossCount).toBe(1);
    expect(s.winRatePct).toBeCloseTo(50, 6);
  });

  it('treats a ~1e-13 float residual as flat, not a win', () => {
    // A round trip built from partial exits can land at a realizedPl of
    // ~1e-13 instead of exactly 0 due to float accumulation. Without an
    // epsilon this buckets as a "win" that displays as $0.00.
    const s = summarizeClosed([closed({ ticker: 'AAA', realizedPl: 1e-13 })]);
    expect(s.winCount).toBe(0);
    expect(s.lossCount).toBe(0);
    expect(s.winRatePct).toBeNull();
    // The summed total itself stays exact -- the epsilon applies only to
    // win/loss bucketing, never to the reported realizedPl total.
    expect(s.realizedPl).toBe(1e-13);
  });

  it('EXCLUDES open episodes from every figure', () => {
    // An open position has no realized result; counting it as a zero-P/L loss
    // would drag the win rate down with a trade that has not happened yet.
    const open = { ...closed({ ticker: 'ZZZ', realizedPl: 0 }), isOpen: true, realizedPl: null };
    const s = summarizeClosed([closed({ ticker: 'AAA', realizedPl: 100 }), open as Episode]);
    expect(s.count).toBe(1);
    expect(s.realizedPl).toBe(100);
  });

  it('averages hold duration across closed episodes', () => {
    const s = summarizeClosed([
      closed({ ticker: 'AAA', realizedPl: 10, holdDays: 1 }),
      closed({ ticker: 'BBB', realizedPl: 10, holdDays: 3 }),
    ]);
    expect(s.avgHoldDays).toBe(2);
  });

  it('returns nulls rather than NaN when there is nothing closed', () => {
    const s = summarizeClosed([]);
    expect(s.count).toBe(0);
    expect(s.realizedPl).toBe(0);
    expect(s.winRatePct).toBeNull();
    expect(s.avgHoldDays).toBeNull();
  });
});

describe('behaviourStats', () => {
  it('counts episodes per ticker, most re-entered first', () => {
    const b = behaviourStats([
      closed({ ticker: 'ONDS', realizedPl: 1 }),
      closed({ ticker: 'ONDS', realizedPl: 1 }),
      closed({ ticker: 'ONDS', realizedPl: 1 }),
      closed({ ticker: 'AAA', realizedPl: 1 }),
    ]);
    expect(b.reEntries[0]).toEqual({ ticker: 'ONDS', episodes: 3 });
  });

  it('counts same-day round trips per ET date, oldest first', () => {
    const b = behaviourStats([
      closed({ ticker: 'AAA', realizedPl: 1, sameEtDay: true, openEtDate: '2026-08-06', closeEtDate: '2026-08-06' }),
      closed({ ticker: 'BBB', realizedPl: 1, sameEtDay: true, openEtDate: '2026-08-06', closeEtDate: '2026-08-06' }),
      closed({ ticker: 'CCC', realizedPl: 1, sameEtDay: true, openEtDate: '2026-08-10', closeEtDate: '2026-08-10' }),
      closed({ ticker: 'DDD', realizedPl: 1, sameEtDay: false }),
    ]);
    expect(b.sameDayByDate).toEqual([
      { etDate: '2026-08-06', count: 2 },
      { etDate: '2026-08-10', count: 1 },
    ]);
  });

  it('buckets hold durations', () => {
    const b = behaviourStats([
      closed({ ticker: 'A', realizedPl: 1, holdDays: 0 }),
      closed({ ticker: 'B', realizedPl: 1, holdDays: 2 }),
      closed({ ticker: 'C', realizedPl: 1, holdDays: 5 }),
      closed({ ticker: 'D', realizedPl: 1, holdDays: 30 }),
    ]);
    expect(b.holdBuckets).toEqual([
      { label: 'same day', count: 1 },
      { label: '1-3d', count: 1 },
      { label: '4-7d', count: 1 },
      { label: '8d+', count: 1 },
    ]);
  });

  it('returns empty collections for no episodes', () => {
    const b = behaviourStats([]);
    expect(b.reEntries).toEqual([]);
    expect(b.sameDayByDate).toEqual([]);
    expect(b.holdBuckets.every((x) => x.count === 0)).toBe(true);
  });
});

describe('calendarDaysBetween', () => {
  it('counts whole calendar days between two ET dates', () => {
    expect(calendarDaysBetween('2026-08-03', '2026-08-05')).toBe(2);
  });

  it('returns 0 for the same date', () => {
    expect(calendarDaysBetween('2026-08-03', '2026-08-03')).toBe(0);
  });
});

describe('sameDayRegression', () => {
  const FIX = '2026-08-10';

  it('counts a date after the fix date as post-fix', () => {
    const r = sameDayRegression([{ etDate: '2026-08-11', count: 2 }], FIX);
    expect(r.preFixCount).toBe(0);
    expect(r.postFixCount).toBe(2);
    expect(r.postFixDates).toEqual(['2026-08-11']);
  });

  it('counts the fix date ITSELF as pre-fix', () => {
    // The gate closed at 11:20 ET that day, after those trades already
    // happened -- the fix date's own rows are the last of the pre-fix era,
    // not the first of the post-fix one.
    const r = sameDayRegression([{ etDate: FIX, count: 3 }], FIX);
    expect(r.preFixCount).toBe(3);
    expect(r.postFixCount).toBe(0);
    expect(r.postFixDates).toEqual([]);
  });

  it('yields zeros for an empty array', () => {
    const r = sameDayRegression([], FIX);
    expect(r).toEqual({ preFixCount: 0, postFixCount: 0, postFixDates: [] });
  });
});
