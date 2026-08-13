import { describe, it, expect } from 'vitest';
import {
  nearestSnapshot, toleranceMinutesFor, baseline,
  sameSourceSet, velocityAt,
  acceleration, computeVelocity,
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

describe('sameSourceSet', () => {
  it('is true for the same sources in any order', () => {
    expect(sameSourceSet(
      snap('2026-08-13T10:00:00Z', 10, ['apewisdom-all', 'stocktwits']),
      snap('2026-08-13T11:00:00Z', 20, ['stocktwits', 'apewisdom-all'])
    )).toBe(true);
  });

  it('is false when one side lost a source', () => {
    expect(sameSourceSet(
      snap('2026-08-13T10:00:00Z', 10, ['apewisdom-all', 'stocktwits']),
      snap('2026-08-13T11:00:00Z', 20, ['stocktwits'])
    )).toBe(false);
  });
});

describe('velocityAt', () => {
  it('computes percentage change against the snapshot one window back', () => {
    const series = [
      snap('2026-08-12T12:00:00Z', 30),
      snap('2026-08-13T12:00:00Z', 180),
    ];
    // (180 - 30) / 30 * 100 = 500
    expect(velocityAt(series, new Date('2026-08-13T12:00:00Z'), 24)).toBe(500);
  });

  it('REFUSES to compare across a source outage', () => {
    // ApeWisdom down at the later reading: mentions collapse from 200 to 5. Compared
    // naively this reads -97.5%, and +infinity on recovery -- every outage would
    // manufacture a fake breakout that Phase 4 would trade.
    const series = [
      snap('2026-08-12T12:00:00Z', 200, ['apewisdom-all', 'stocktwits']),
      snap('2026-08-13T12:00:00Z', 5, ['stocktwits']),
    ];
    expect(velocityAt(series, new Date('2026-08-13T12:00:00Z'), 24)).toBeNull();
  });

  it('floors the denominator so a near-zero prior value cannot explode', () => {
    const series = [
      snap('2026-08-12T12:00:00Z', 1),
      snap('2026-08-13T12:00:00Z', 100),
    ];
    // Denominator floored at MIN_BASELINE=5, so (100-1)/5*100 = 1980, not 9900.
    expect(velocityAt(series, new Date('2026-08-13T12:00:00Z'), 24)).toBe(1980);
  });

  it('returns null when there is no snapshot within tolerance', () => {
    const series = [snap('2026-08-13T12:00:00Z', 100)];
    expect(velocityAt(series, new Date('2026-08-13T12:00:00Z'), 24)).toBeNull();
  });

  it('handles a 24h window across a DST boundary using absolute time', () => {
    // 2026-11-01 is the US DST fall-back. Using absolute ms rather than calendar
    // arithmetic means the window is exactly 24h regardless.
    const series = [
      snap('2026-10-31T16:00:00Z', 50),
      snap('2026-11-01T16:00:00Z', 100),
    ];
    expect(velocityAt(series, new Date('2026-11-01T16:00:00Z'), 24)).toBe(100);
  });
});

/** 7 days of half-hourly snapshots at a flat level, for baseline/sample-count setup. */
function flatSeries(level: number, endIso: string, hours = 24 * 7): Snapshot[] {
  const end = new Date(endIso).getTime();
  const out: Snapshot[] = [];
  for (let h = hours; h >= 0; h -= 0.5) {
    out.push({
      capturedAt: new Date(end - h * 3_600_000),
      mentions: level,
      sourcesPresent: ['apewisdom-all'],
    });
  }
  return out;
}

describe('acceleration', () => {
  it('is positive when 1h velocity is increasing', () => {
    const now = new Date('2026-08-13T12:00:00Z');
    const series = [
      snap('2026-08-13T10:00:00Z', 100),
      snap('2026-08-13T11:00:00Z', 110), // prior 1h velocity: +10%
      snap('2026-08-13T12:00:00Z', 143), // current 1h velocity: +30%
    ];
    expect(acceleration(series, now)).toBeCloseTo(20, 1); // 30 - 10 percentage points
  });

  it('is null when either 1h velocity is unavailable', () => {
    const series = [snap('2026-08-13T12:00:00Z', 100)];
    expect(acceleration(series, new Date('2026-08-13T12:00:00Z'))).toBeNull();
  });
});

describe('computeVelocity reliability', () => {
  const now = new Date('2026-08-13T12:00:00Z');

  it('marks 1 -> 6 mentions UNRELIABLE even though it is +500%', () => {
    // The small-number trap. 1 -> 6 and 30 -> 180 are both "+500%"; the first is noise.
    // Without the floor, noise ranks top of the radar every single run.
    const series = [...flatSeries(1, '2026-08-13T11:00:00Z'), snap('2026-08-13T12:00:00Z', 6)];
    const m = computeVelocity(series, now);
    expect(m.isReliable).toBe(false);
  });

  it('marks 30 -> 180 mentions RELIABLE', () => {
    const series = [...flatSeries(30, '2026-08-13T11:00:00Z'), snap('2026-08-13T12:00:00Z', 180)];
    const m = computeVelocity(series, now);
    expect(m.isReliable).toBe(true);
    expect(m.mentionsNow).toBe(180);
  });

  it('is unreliable with too few samples even at a healthy mention count', () => {
    const series = [
      snap('2026-08-13T11:00:00Z', 100),
      snap('2026-08-13T12:00:00Z', 300),
    ];
    expect(computeVelocity(series, now).sampleCount).toBeLessThan(6);
    expect(computeVelocity(series, now).isReliable).toBe(false);
  });

  it('returns an all-null, unreliable result for an empty series without throwing', () => {
    const m = computeVelocity([], now);
    expect(m.isReliable).toBe(false);
    expect(m.vel24h).toBeNull();
    expect(m.sampleCount).toBe(0);
    expect(m.mentionsNow).toBe(0);
  });

  it('handles an all-zero series without dividing by zero', () => {
    // A ticker present in the feed but with no mentions at all. The MIN_BASELINE
    // floor in velocityAt is what keeps this finite rather than NaN or Infinity.
    const m = computeVelocity(flatSeries(0, '2026-08-13T12:00:00Z'), now);
    expect(m.isReliable).toBe(false);
    expect(m.vel24h).toBe(0);
    expect(Number.isNaN(m.vel24h)).toBe(false);
  });
});
