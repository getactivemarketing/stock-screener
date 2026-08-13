import { describe, it, expect } from 'vitest';
import { toSnapshotRows } from './attention-capture';
import type { MergedSentiment } from '../types/index.js';

const merged = (o: Partial<MergedSentiment> & { ticker: string }): MergedSentiment =>
  ({ totalMentions: 0, avgSentiment: 0, maxMomentum: 1, sourceCount: 0, sources: {}, ...o }) as MergedSentiment;

describe('toSnapshotRows', () => {
  it('records which sources were present, sorted for stable comparison', () => {
    const rows = toSnapshotRows({
      AAA: merged({
        ticker: 'AAA',
        totalMentions: 120,
        sources: {
          stocktwits: { ticker: 'AAA', source: 'stocktwits', mentions: 20, sentiment: 0.5 },
          'apewisdom-all': { ticker: 'AAA', source: 'apewisdom-all', mentions: 100, sentiment: 0.6, rank: 12 },
        } as MergedSentiment['sources'],
      }),
    });
    // Sorted so sameSourceSet comparisons and stored arrays are order-independent.
    expect(rows[0].sourcesPresent).toEqual(['apewisdom-all', 'stocktwits']);
    expect(rows[0].totalMentions).toBe(120);
  });

  it('EXCLUDES sector-research, which is an internal candidate feed not an attention source', () => {
    // Counting it would make a source set differ purely because the bot queued a
    // sector candidate, and every velocity comparison for that ticker would go null.
    const rows = toSnapshotRows({
      BBB: merged({
        ticker: 'BBB',
        totalMentions: 10,
        sources: {
          'apewisdom-all': { ticker: 'BBB', source: 'apewisdom-all', mentions: 10, sentiment: 0.1 },
          'sector-research': { ticker: 'BBB', source: 'sector-research', mentions: 0, sentiment: 0 },
        } as MergedSentiment['sources'],
      }),
    });
    expect(rows[0].sourcesPresent).toEqual(['apewisdom-all']);
  });

  it('pulls the apewisdom rank from whichever apewisdom feed carries it', () => {
    const rows = toSnapshotRows({
      CCC: merged({
        ticker: 'CCC',
        totalMentions: 50,
        sources: {
          'apewisdom-wsb': { ticker: 'CCC', source: 'apewisdom-wsb', mentions: 50, sentiment: 0.2, rank: 7 },
        } as MergedSentiment['sources'],
      }),
    });
    expect(rows[0].apewisdomRank).toBe(7);
    expect(rows[0].apewisdomMentions).toBe(50);
  });

  it('returns an empty array for an empty universe', () => {
    expect(toSnapshotRows({})).toEqual([]);
  });
});
