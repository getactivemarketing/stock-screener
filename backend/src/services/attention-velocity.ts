/**
 * Attention velocity: how fast a ticker's mention count is changing.
 *
 * Pure module -- no db, no fetch, no clock. `now` is always passed in so every
 * behaviour is reproducible in a test.
 *
 * The screener scores attention as a LEVEL. A stock at 1,500 mentions that was at
 * 1,600 yesterday scores high and is decaying; a stock at 180 that was at 30 scores
 * low and is where the opportunity is. This module measures the second thing.
 */

export const MIN_MENTIONS_NOW = 25;
export const MIN_BASELINE = 5;
export const MIN_SAMPLES = 6;
export const TOLERANCE_FRACTION = 0.25;
export const MIN_TOLERANCE_MINUTES = 45;
export const BASELINE_DAYS = 7;
export const BASELINE_EXCLUDE_RECENT_HOURS = 1;

export interface Snapshot {
  capturedAt: Date;
  mentions: number;
  sourcesPresent: string[];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Tolerance scales with the window, floored so short windows stay usable: 25% of a
 * 1h window is 15 minutes, shorter than a single 30-minute capture interval, which
 * would make every 1h reading null.
 */
export function toleranceMinutesFor(windowHours: number): number {
  return Math.max(MIN_TOLERANCE_MINUTES, windowHours * 60 * TOLERANCE_FRACTION);
}

/**
 * Closest snapshot to `target`, or null if the closest one is further away than
 * `toleranceMinutes`. Returning null is the point: a missed capture run is a gap,
 * and interpolating across it invents data.
 */
export function nearestSnapshot(
  series: Snapshot[],
  target: Date,
  toleranceMinutes: number
): Snapshot | null {
  let best: Snapshot | null = null;
  let bestDelta = Infinity;
  for (const s of series) {
    const delta = Math.abs(s.capturedAt.getTime() - target.getTime());
    if (delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  if (!best || bestDelta > toleranceMinutes * MINUTE_MS) return null;
  return best;
}

/**
 * Mean mentions over the trailing `days`, EXCLUDING the most recent hour.
 *
 * The exclusion is load-bearing. Without it a live spike is inside its own baseline,
 * inflating the denominator and damping the very signal being measured -- the failure
 * would be silent and would make every real breakout look smaller than it is.
 */
export function baseline(
  series: Snapshot[],
  now: Date,
  days: number = BASELINE_DAYS
): number | null {
  const windowStart = now.getTime() - days * 24 * HOUR_MS;
  const cutoff = now.getTime() - BASELINE_EXCLUDE_RECENT_HOURS * HOUR_MS;
  const inWindow = series.filter(
    (s) => s.capturedAt.getTime() >= windowStart && s.capturedAt.getTime() <= cutoff
  );
  if (inWindow.length === 0) return null;
  return inWindow.reduce((sum, s) => sum + s.mentions, 0) / inWindow.length;
}

/**
 * Whether two snapshots were built from the same set of sources.
 *
 * If ApeWisdom is down for one run, affected tickers' mention counts collapse toward
 * zero. Compared naively that reads -100%, then +infinity on recovery. Every source
 * outage would manufacture a fake breakout -- and Phase 4 would trade it.
 *
 * This is stricter than computing over the intersection of the two source sets: it
 * refuses the comparison entirely. Strictness is the right default while the signal
 * is unvalidated; intersection-based comparison is a possible refinement once there
 * is evidence that outages are frequent enough to be worth salvaging.
 */
export function sameSourceSet(a: Snapshot, b: Snapshot): boolean {
  if (a.sourcesPresent.length !== b.sourcesPresent.length) return false;
  const setA = new Set(a.sourcesPresent);
  return b.sourcesPresent.every((s) => setA.has(s));
}

/**
 * Percentage change in mentions against the snapshot one window back.
 *
 * Returns null -- never a number -- when the comparison cannot be trusted: no
 * snapshot within tolerance, or a source-set mismatch. Callers must treat null as
 * "unknown", never as zero.
 */
export function velocityAt(
  series: Snapshot[],
  now: Date,
  windowHours: number
): number | null {
  const current = nearestSnapshot(series, now, toleranceMinutesFor(1));
  if (!current) return null;

  const target = new Date(now.getTime() - windowHours * HOUR_MS);
  const past = nearestSnapshot(series, target, toleranceMinutesFor(windowHours));
  if (!past) return null;

  if (!sameSourceSet(current, past)) return null;

  const denominator = Math.max(past.mentions, MIN_BASELINE);
  return ((current.mentions - past.mentions) / denominator) * 100;
}

export interface VelocityMetrics {
  mentionsNow: number;
  vel1h: number | null;
  vel6h: number | null;
  vel24h: number | null;
  vel7d: number | null;
  acceleration: number | null;
  baselineMentions: number | null;
  sampleCount: number;
  isReliable: boolean;
}

/**
 * Change in the 1h velocity itself, in percentage points: how fast the rate of
 * attention growth is itself growing. Null if either endpoint is unavailable.
 */
export function acceleration(series: Snapshot[], now: Date): number | null {
  const current = velocityAt(series, now, 1);
  const previous = velocityAt(series, new Date(now.getTime() - HOUR_MS), 1);
  if (current === null || previous === null) return null;
  return current - previous;
}

/**
 * All velocity metrics for one ticker.
 *
 * `isReliable` is the gate every consumer must respect. Percentage change without an
 * absolute floor is a noise generator: 1 -> 6 is "+500%" and so is 30 -> 180. Under
 * the shipped defaults the first is unreliable and the second is not, which is the
 * intended boundary.
 */
export function computeVelocity(series: Snapshot[], now: Date): VelocityMetrics {
  const current = nearestSnapshot(series, now, toleranceMinutesFor(1));
  const mentionsNow = current?.mentions ?? 0;

  const windowStart = now.getTime() - BASELINE_DAYS * 24 * HOUR_MS;
  const sampleCount = series.filter(
    (s) => s.capturedAt.getTime() >= windowStart && s.capturedAt.getTime() <= now.getTime()
  ).length;

  const baselineMentions = baseline(series, now);

  const isReliable =
    mentionsNow >= MIN_MENTIONS_NOW &&
    baselineMentions !== null &&
    baselineMentions >= MIN_BASELINE &&
    sampleCount >= MIN_SAMPLES;

  return {
    mentionsNow,
    vel1h: velocityAt(series, now, 1),
    vel6h: velocityAt(series, now, 6),
    vel24h: velocityAt(series, now, 24),
    vel7d: velocityAt(series, now, 24 * 7),
    acceleration: acceleration(series, now),
    baselineMentions,
    sampleCount,
    isReliable,
  };
}
