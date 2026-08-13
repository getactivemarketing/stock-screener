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
