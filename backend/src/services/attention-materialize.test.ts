import { describe, it, expect } from 'vitest';
import { rowsToSeries } from './attention-materialize';

describe('rowsToSeries', () => {
  it('converts db rows into Snapshots with real Date objects', () => {
    const series = rowsToSeries([
      { captured_at: '2026-08-13T12:00:00Z', total_mentions: 100, sources_present: ['apewisdom-all'] },
    ]);
    expect(series[0].capturedAt instanceof Date).toBe(true);
    expect(series[0].mentions).toBe(100);
    expect(series[0].sourcesPresent).toEqual(['apewisdom-all']);
  });

  it('defaults a null sources_present to an empty array rather than crashing', () => {
    const series = rowsToSeries([
      { captured_at: '2026-08-13T12:00:00Z', total_mentions: 5, sources_present: null },
    ]);
    expect(series[0].sourcesPresent).toEqual([]);
  });

  it('returns an empty array for no rows', () => {
    expect(rowsToSeries([])).toEqual([]);
  });
});
