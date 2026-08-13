import { describe, it, expect } from 'vitest';
import {
  nearestSnapshot, toleranceMinutesFor, baseline,
  type Snapshot,
} from './attention-velocity';

const snap = (isoTime: string, mentions: number, sources = ['apewisdom-all']): Snapshot => ({
  capturedAt: new Date(isoTime),
  mentions,
  sourcesPresent: sources,
});

describe('toleranceMinutesFor', () => {
  it('is 25% of the window once the window is large enough', () => {
    expect(toleranceMinutesFor(24)).toBe(360); // 24h * 60 * 0.25
  });

  it('floors at 45 minutes so short windows stay usable', () => {
    // 1h * 60 * 0.25 = 15 min, which is shorter than one 30-min capture interval.
    expect(toleranceMinutesFor(1)).toBe(45);
  });
});

describe('nearestSnapshot', () => {
  const series = [
    snap('2026-08-13T10:00:00Z', 100),
    snap('2026-08-13T10:30:00Z', 110),
    snap('2026-08-13T11:00:00Z', 130),
  ];

  it('picks the closest snapshot to the target', () => {
    expect(nearestSnapshot(series, new Date('2026-08-13T10:35:00Z'), 45)?.mentions).toBe(110);
  });

  it('returns null when the closest snapshot is outside tolerance', () => {
    // Nearest is 11:00, which is 4h from the target -- a gap, not a measurement.
    expect(nearestSnapshot(series, new Date('2026-08-13T15:00:00Z'), 45)).toBeNull();
  });

  it('returns null for an empty series rather than throwing', () => {
    expect(nearestSnapshot([], new Date('2026-08-13T10:00:00Z'), 45)).toBeNull();
  });
});

describe('baseline', () => {
  it('averages mentions over the trailing window', () => {
    const series = [
      snap('2026-08-10T12:00:00Z', 10),
      snap('2026-08-11T12:00:00Z', 20),
      snap('2026-08-12T12:00:00Z', 30),
    ];
    expect(baseline(series, new Date('2026-08-13T12:00:00Z'), 7)).toBe(20);
  });

  it('EXCLUDES the most recent hour so a live spike cannot inflate its own baseline', () => {
    // Without the exclusion the 1000-mention spike drags the baseline up and the
    // velocity it produces is silently damped -- the bug this rule exists to prevent.
    const series = [
      snap('2026-08-12T12:00:00Z', 10),
      snap('2026-08-13T11:45:00Z', 1000), // inside the excluded hour
    ];
    expect(baseline(series, new Date('2026-08-13T12:00:00Z'), 7)).toBe(10);
  });

  it('returns null when no samples remain after exclusion', () => {
    const series = [snap('2026-08-13T11:45:00Z', 1000)];
    expect(baseline(series, new Date('2026-08-13T12:00:00Z'), 7)).toBeNull();
  });
});
