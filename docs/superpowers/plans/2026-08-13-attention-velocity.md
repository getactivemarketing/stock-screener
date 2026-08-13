# Attention Velocity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the full sentiment universe every 30 minutes around the clock, and compute per-ticker attention velocity and acceleration from it.

**Architecture:** A lightweight capture cron writes raw mention counts for every merged ticker to `attention_snapshots`. A pure, I/O-free module computes velocity from that series. A materialization step writes the computed metrics to `attention_velocity`, which is the frozen record of what any consumer saw at decision time.

**Tech Stack:** Node.js 20+, TypeScript 5.7, PostgreSQL (Railway), vitest, tsx.

## Scope

This plan covers **Phase 1 (capture) and Phase 2 (velocity computation)** from
`docs/superpowers/specs/2026-08-13-attention-velocity-design.md`.

Phase 3 (dashboard `/radar`) and Phase 4 (`velocity_breakout` trading category) are
**deliberately excluded** and get their own plans. Both are gated on Phase 1 having
accumulated 2–4 weeks of real data, and writing their plans now would mean guessing at
thresholds that this plan's output is supposed to measure.

What this plan delivers on its own: a running 24/7 capture job, a tested velocity module,
and a populated `attention_velocity` table. That is independently useful — it answers
"is attention acceleration even a real signal?" — without anything trading on it.

## Global Constants

Copied verbatim from the spec. Every task's requirements implicitly include these.

```ts
export const MIN_MENTIONS_NOW = 25;       // below this, percentage change is noise
export const MIN_BASELINE = 5;            // near-zero baseline makes any ratio explode
export const MIN_SAMPLES = 6;             // ~3h of coverage at 30-min cadence
export const TOLERANCE_FRACTION = 0.25;   // 25% of the requested window
export const MIN_TOLERANCE_MINUTES = 45;  // ~1.5 capture intervals
export const BASELINE_DAYS = 7;
export const BASELINE_EXCLUDE_RECENT_HOURS = 1;
```

## Global Constraints

- `ticker VARCHAR(10)` — matches every other ticker column in the schema. Do not widen.
- All timestamps are `TIMESTAMPTZ`. Any calendar-date grouping must use
  `to_char(col AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')`. The node-postgres driver
  parses bare `DATE` columns at process-timezone midnight, which on a UTC container is
  20:00 ET the previous day. This has caused three production bugs.
- Never interpolate across a gap. Missing data returns `null`.
- No new npm dependencies.
- Railway crons run via an npm script in a `railway.*.toml`, not via `RUN_MODE`.
- `db.query` returns **rows directly**, not a `{ rows }` wrapper.

## File Structure

| File | Responsibility |
|---|---|
| `database/migration-020-attention-velocity.sql` | Both new tables + indexes |
| `backend/src/services/attention-velocity.ts` | Pure math. No I/O, no db, no fetch |
| `backend/src/services/attention-velocity.test.ts` | Unit tests for the above |
| `backend/src/services/attention-capture.ts` | Fetch → map → persist snapshots |
| `backend/src/services/attention-capture.test.ts` | Mapping tests (pure part) |
| `backend/src/services/attention-materialize.ts` | Read series → compute → write velocity rows |
| `backend/src/services/attention-materialize.test.ts` | Tests with mocked db |
| `backend/src/attention-runner.ts` | Cron entry point |
| `backend/railway.attention.toml` | 24/7 cron config |
| `backend/src/pipeline-unified.ts` | **Modify**: export `fetchAllSentimentData` |
| `backend/package.json` | **Modify**: add `attention` script |

---

### Task 1: Migration for both tables

**Files:**
- Create: `database/migration-020-attention-velocity.sql`

**Interfaces:**
- Consumes: nothing
- Produces: tables `attention_snapshots` and `attention_velocity`

- [ ] **Step 1: Write the migration**

```sql
-- Migration 020: attention snapshots + computed velocity
--
-- pipeline-unified.ts merges all sentiment sources into a full universe and then
-- truncates to MAX_CANDIDATES=40 before persisting ~18 rows to scan_results. The
-- full universe is discarded every 30 minutes, so a ticker only enters scan_results
-- AFTER it already made the cut -- there is no "before" value for a stock going
-- 30 -> 180 mentions. These tables capture the whole universe so velocity is
-- computable for tickers the screener has not noticed yet.

CREATE TABLE IF NOT EXISTS attention_snapshots (
  id                  UUID PRIMARY KEY,
  ticker              VARCHAR(10) NOT NULL,
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_mentions      INTEGER NOT NULL,
  apewisdom_mentions  INTEGER,
  apewisdom_rank      INTEGER,
  stocktwits_mentions INTEGER,
  swaggy_mentions     INTEGER,
  sources_present     TEXT[] NOT NULL,
  avg_sentiment       NUMERIC(6,3)
);

CREATE INDEX IF NOT EXISTS idx_att_snap_ticker_time
  ON attention_snapshots (ticker, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_att_snap_time
  ON attention_snapshots (captured_at DESC);

CREATE TABLE IF NOT EXISTS attention_velocity (
  id                UUID PRIMARY KEY,
  ticker            VARCHAR(10) NOT NULL,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  mentions_now      INTEGER NOT NULL,
  vel_1h            NUMERIC(10,2),
  vel_6h            NUMERIC(10,2),
  vel_24h           NUMERIC(10,2),
  vel_7d            NUMERIC(10,2),
  acceleration      NUMERIC(10,2),
  baseline_mentions NUMERIC(10,2),
  sample_count      INTEGER NOT NULL,
  is_reliable       BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_att_vel_time
  ON attention_velocity (computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_att_vel_ticker_time
  ON attention_velocity (ticker, computed_at DESC);
```

- [ ] **Step 2: Apply to the local/dev database and verify**

Run:
```bash
psql "$DATABASE_URL" -f database/migration-020-attention-velocity.sql
psql "$DATABASE_URL" -c "\d attention_snapshots"
psql "$DATABASE_URL" -c "\d attention_velocity"
```
Expected: both tables listed with the columns above, and 2 indexes each.

- [ ] **Step 3: Commit**

```bash
git add database/migration-020-attention-velocity.sql
git commit -m "Add attention_snapshots and attention_velocity tables"
```

---

### Task 2: Velocity primitives — baseline and window matching

**Files:**
- Create: `backend/src/services/attention-velocity.ts`
- Test: `backend/src/services/attention-velocity.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface Snapshot { capturedAt: Date; mentions: number; sourcesPresent: string[] }`
  - `nearestSnapshot(series: Snapshot[], target: Date, toleranceMinutes: number): Snapshot | null`
  - `toleranceMinutesFor(windowHours: number): number`
  - `baseline(series: Snapshot[], now: Date, days?: number): number | null`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/attention-velocity.test.ts`
Expected: FAIL — `Cannot find module './attention-velocity'`. Create the file with the
signatures below returning `null`/`0`, re-run, and confirm the failures become
**assertion** failures before implementing. A module-not-found error is not a valid RED.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/attention-velocity.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/attention-velocity.ts backend/src/services/attention-velocity.test.ts
git commit -m "Add attention velocity primitives: window matching and baseline"
```

---

### Task 3: Source-set integrity — the outage guard

This is the highest-severity correctness property in the feature. Give it its own review gate.

**Files:**
- Modify: `backend/src/services/attention-velocity.ts`
- Test: `backend/src/services/attention-velocity.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `nearestSnapshot`, `toleranceMinutesFor` from Task 2
- Produces: `sameSourceSet(a: Snapshot, b: Snapshot): boolean`,
  `velocityAt(series: Snapshot[], now: Date, windowHours: number): number | null`

- [ ] **Step 1: Write the failing tests**

```ts
import { sameSourceSet, velocityAt } from './attention-velocity';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/attention-velocity.test.ts -t 'sameSourceSet|velocityAt'`
Expected: FAIL — `sameSourceSet is not a function`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/attention-velocity.test.ts`
Expected: PASS, 14 tests total.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/attention-velocity.ts backend/src/services/attention-velocity.test.ts
git commit -m "Refuse velocity comparison across a source outage"
```

---

### Task 4: acceleration, computeVelocity, and the reliability floors

**Files:**
- Modify: `backend/src/services/attention-velocity.ts`
- Test: `backend/src/services/attention-velocity.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–3
- Produces:
  - `interface VelocityMetrics { mentionsNow: number; vel1h: number|null; vel6h: number|null; vel24h: number|null; vel7d: number|null; acceleration: number|null; baselineMentions: number|null; sampleCount: number; isReliable: boolean }`
  - `acceleration(series: Snapshot[], now: Date): number | null`
  - `computeVelocity(series: Snapshot[], now: Date): VelocityMetrics`

Note: `mentionsNow` is present here but absent from the interface sketch in the spec.
The plan is correct — `attention_velocity.mentions_now` is `NOT NULL` and Task 7 needs a
value to write.

- [ ] **Step 1: Write the failing tests**

```ts
import { acceleration, computeVelocity } from './attention-velocity';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/attention-velocity.test.ts -t 'acceleration|reliability'`
Expected: FAIL — `acceleration is not a function`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/attention-velocity.test.ts && npx tsc --noEmit`
Expected: PASS, 20 tests total. `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/attention-velocity.ts backend/src/services/attention-velocity.test.ts
git commit -m "Add acceleration and reliability floors to attention velocity"
```

---

### Task 5: Capture service

**Files:**
- Create: `backend/src/services/attention-capture.ts`
- Test: `backend/src/services/attention-capture.test.ts`
- Modify: `backend/src/pipeline-unified.ts` (export `fetchAllSentimentData`)

**Interfaces:**
- Consumes: `mergeSentimentByTicker` and `fetchAllSentimentData` from `pipeline-unified.ts`;
  `MergedSentiment` from `../types/index.js`
- Produces:
  - `interface SnapshotRow { ticker; totalMentions; apewisdomMentions; apewisdomRank; stocktwitsMentions; swaggyMentions; sourcesPresent; avgSentiment }`
  - `toSnapshotRows(merged: Record<string, MergedSentiment>): SnapshotRow[]`
  - `captureAttention(): Promise<number>` — returns rows written

Note: `fetchAllSentimentData` is currently a module-private `async function` at
`pipeline-unified.ts:114`. Add it to the existing export list at line ~946; do not move
or reimplement it.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/attention-capture.test.ts`
Expected: FAIL — module not found; then create the file and confirm assertion failures.

- [ ] **Step 3: Write the implementation**

```ts
import { v4 as uuidv4 } from 'uuid';
import db from '../db/index.js';
import { fetchAllSentimentData, mergeSentimentByTicker } from '../pipeline-unified.js';
import type { MergedSentiment } from '../types/index.js';

/**
 * Attention capture.
 *
 * pipeline-unified.ts merges every sentiment source into a full universe and then
 * truncates to MAX_CANDIDATES=40 before persisting ~18 rows. The rest is discarded
 * every 30 minutes, so a ticker only ever enters scan_results AFTER it made the cut.
 * That makes velocity uncomputable for exactly the stocks worth catching early.
 *
 * This service persists the WHOLE universe, and nothing else. No market data, no
 * classifier, no AI -- those are the expensive, rate-limited calls, and omitting them
 * is what makes running this around the clock affordable.
 */

/** Internal candidate feed, not a measure of public attention. */
const NON_ATTENTION_SOURCES = new Set(['sector-research']);

export interface SnapshotRow {
  ticker: string;
  totalMentions: number;
  apewisdomMentions: number | null;
  apewisdomRank: number | null;
  stocktwitsMentions: number | null;
  swaggyMentions: number | null;
  sourcesPresent: string[];
  avgSentiment: number | null;
}

export function toSnapshotRows(merged: Record<string, MergedSentiment>): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  for (const m of Object.values(merged)) {
    const sources = Object.entries(m.sources).filter(
      ([name, data]) => !!data && !NON_ATTENTION_SOURCES.has(name)
    );
    // Sorted so stored arrays compare order-independently downstream.
    const sourcesPresent = sources.map(([name]) => name).sort();

    const ape = sources.filter(([n]) => n.startsWith('apewisdom')).map(([, d]) => d!);
    const apewisdomMentions = ape.length
      ? ape.reduce((sum, d) => sum + (d.mentions ?? 0), 0)
      : null;
    const ranked = ape.find((d) => typeof (d as { rank?: number }).rank === 'number');

    rows.push({
      ticker: m.ticker.toUpperCase(),
      totalMentions: m.totalMentions,
      apewisdomMentions,
      apewisdomRank: (ranked as { rank?: number } | undefined)?.rank ?? null,
      stocktwitsMentions: m.sources.stocktwits?.mentions ?? null,
      swaggyMentions: m.sources.swaggy?.mentions ?? null,
      sourcesPresent,
      avgSentiment: Number.isFinite(m.avgSentiment) ? m.avgSentiment : null,
    });
  }
  return rows;
}

/**
 * Fetch, map, and persist one capture run. Returns the number of rows written.
 *
 * A partial capture must NOT write partial rows: if the fetch throws, the run is
 * abandoned and the gap stays visible. A gap returns null downstream; a silently
 * half-written run would instead look like a universe-wide collapse in mentions and
 * would manufacture fake breakouts on recovery.
 */
export async function captureAttention(): Promise<number> {
  const { sentiment } = await fetchAllSentimentData();
  const merged = mergeSentimentByTicker(sentiment);
  const rows = toSnapshotRows(merged);

  if (rows.length === 0) {
    console.error('[AttentionCapture] Universe is EMPTY -- writing nothing, leaving a visible gap.');
    return 0;
  }

  for (const r of rows) {
    await db.query(
      `INSERT INTO attention_snapshots (
         id, ticker, total_mentions, apewisdom_mentions, apewisdom_rank,
         stocktwits_mentions, swaggy_mentions, sources_present, avg_sentiment
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuidv4(), r.ticker, r.totalMentions, r.apewisdomMentions, r.apewisdomRank,
       r.stocktwitsMentions, r.swaggyMentions, r.sourcesPresent, r.avgSentiment]
    );
  }

  console.log(`[AttentionCapture] Wrote ${rows.length} snapshots.`);
  return rows.length;
}
```

- [ ] **Step 4: Export `fetchAllSentimentData` from pipeline-unified.ts**

Change the export list at the bottom of `backend/src/pipeline-unified.ts` (currently
line ~946) from:

```ts
export { runUnifiedPipeline, classifyEntryCategory, selectTopCandidates, mergeSentimentByTicker };
```

to:

```ts
export { runUnifiedPipeline, classifyEntryCategory, selectTopCandidates, mergeSentimentByTicker, fetchAllSentimentData };
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd backend && npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/attention-capture.ts backend/src/services/attention-capture.test.ts backend/src/pipeline-unified.ts
git commit -m "Add attention capture for the full sentiment universe"
```

---

### Task 6: Runner, npm script, Railway cron, and universe measurement

**Files:**
- Create: `backend/src/attention-runner.ts`
- Create: `backend/railway.attention.toml`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: `captureAttention` from Task 5
- Produces: `npm run attention`

- [ ] **Step 1: Write the runner**

```ts
import { captureAttention } from './services/attention-capture.js';

/**
 * Entry point for the 24/7 attention capture cron.
 *
 * Runs on its own schedule rather than inside the screener pipeline, whose cron is
 * `*/30 14-22 * * 1-5` -- weekdays 10:00-18:30 ET only, and therefore blind to the
 * overnight and weekend windows where retail attention actually builds.
 */
async function main() {
  const started = Date.now();
  try {
    const written = await captureAttention();
    console.log(`[AttentionRunner] Done: ${written} rows in ${Date.now() - started}ms`);
    process.exit(0);
  } catch (err) {
    console.error('[AttentionRunner] Capture FAILED -- leaving a gap rather than partial data:', err);
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Add the npm script**

In `backend/package.json`, add to `"scripts"`:

```json
"attention": "tsx src/attention-runner.ts"
```

- [ ] **Step 3: Write the Railway cron config**

```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "npm run attention"
restartPolicyType = "never"

# Every 30 minutes, 24/7 -- deliberately NOT restricted to market hours. Retail
# attention builds overnight and at weekends, which the screener pipeline's
# `*/30 14-22 * * 1-5` window cannot see.
[cron]
schedule = "*/30 * * * *"
```

- [ ] **Step 4: Run one capture locally and MEASURE the universe**

Run:
```bash
cd backend && npm run attention
psql "$DATABASE_URL" -c "SELECT count(*) rows, count(DISTINCT ticker) tickers FROM attention_snapshots;"
```
Expected: a non-zero row count. **Record the ticker count** — it is the input to the
retention decision the spec deliberately left open. At 48 runs/day, annual rows ≈
`tickers × 48 × 365`. If that exceeds ~10M, open a follow-up issue for a rollup policy;
do not add one speculatively.

- [ ] **Step 5: Verify a second run produces a comparable universe**

Run:
```bash
cd backend && npm run attention
psql "$DATABASE_URL" -c "SELECT to_char(captured_at,'HH24:MI') t, count(*) n FROM attention_snapshots GROUP BY 1 ORDER BY 1 DESC LIMIT 5;"
```
Expected: two runs of similar size. A large drop between runs means a source failed —
investigate before deploying, because that is exactly the outage case Task 3 guards.

- [ ] **Step 6: Commit**

```bash
git add backend/src/attention-runner.ts backend/railway.attention.toml backend/package.json
git commit -m "Add 24/7 attention capture cron"
```

---

### Task 7: Materialize velocity rows

**Files:**
- Create: `backend/src/services/attention-materialize.ts`
- Test: `backend/src/services/attention-materialize.test.ts`

**Interfaces:**
- Consumes: `computeVelocity`, `Snapshot` from Task 4
- Produces: `rowsToSeries(rows): Snapshot[]`, `materializeVelocity(now?: Date): Promise<number>`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/attention-materialize.test.ts`
Expected: FAIL — module not found; create the file, then confirm assertion failures.

- [ ] **Step 3: Write the implementation**

```ts
import { v4 as uuidv4 } from 'uuid';
import db from '../db/index.js';
import { computeVelocity, BASELINE_DAYS, type Snapshot } from './attention-velocity.js';

export interface SnapshotDbRow {
  captured_at: string | Date;
  total_mentions: number;
  sources_present: string[] | null;
}

export function rowsToSeries(rows: SnapshotDbRow[]): Snapshot[] {
  return rows.map((r) => ({
    capturedAt: r.captured_at instanceof Date ? r.captured_at : new Date(r.captured_at),
    mentions: r.total_mentions,
    sourcesPresent: r.sources_present ?? [],
  }));
}

/**
 * Compute and persist velocity for every ticker seen recently.
 *
 * The written row is the frozen record of what a consumer saw at decision time -- the
 * same reason config_snapshot and entry_composite are stamped onto entry rows today.
 * When a velocity-driven decision goes wrong, the triggering numbers must be
 * recoverable without recomputation against data that has since changed.
 */
export async function materializeVelocity(now: Date = new Date()): Promise<number> {
  const tickers = await db.query<{ ticker: string }>(
    `SELECT DISTINCT ticker FROM attention_snapshots
      WHERE captured_at > now() - interval '2 hours'`
  );

  let written = 0;
  for (const { ticker } of tickers) {
    // make_interval keeps this parameterized. Do NOT interpolate the interval into
    // the SQL string -- the project rule is parameterized queries without exception,
    // and a constant today becomes a config value tomorrow.
    const rows = await db.query<SnapshotDbRow>(
      `SELECT captured_at, total_mentions, sources_present
         FROM attention_snapshots
        WHERE ticker = $1 AND captured_at > now() - make_interval(days => $2)
        ORDER BY captured_at ASC`,
      [ticker, BASELINE_DAYS]
    );
    const m = computeVelocity(rowsToSeries(rows), now);

    await db.query(
      `INSERT INTO attention_velocity (
         id, ticker, mentions_now, vel_1h, vel_6h, vel_24h, vel_7d,
         acceleration, baseline_mentions, sample_count, is_reliable
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv4(), ticker, m.mentionsNow, m.vel1h, m.vel6h, m.vel24h, m.vel7d,
       m.acceleration, m.baselineMentions, m.sampleCount, m.isReliable]
    );
    written++;
  }

  console.log(`[AttentionMaterialize] Wrote ${written} velocity rows.`);
  return written;
}
```

- [ ] **Step 4: Wire it into the runner**

In `backend/src/attention-runner.ts`, import `materializeVelocity` and call it after
`captureAttention()` so each capture is immediately followed by a recomputation:

```ts
import { captureAttention } from './services/attention-capture.js';
import { materializeVelocity } from './services/attention-materialize.js';

async function main() {
  const started = Date.now();
  try {
    const written = await captureAttention();
    const velocities = await materializeVelocity();
    console.log(`[AttentionRunner] Done: ${written} snapshots, ${velocities} velocity rows in ${Date.now() - started}ms`);
    process.exit(0);
  } catch (err) {
    console.error('[AttentionRunner] Capture FAILED -- leaving a gap rather than partial data:', err);
    process.exit(1);
  }
}

main();
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `cd backend && npx vitest run && npx tsc --noEmit`
Expected: all tests PASS (24 total across the new files plus the 108 existing),
`tsc` exits 0.

- [ ] **Step 6: End-to-end check**

Run:
```bash
cd backend && npm run attention
psql "$DATABASE_URL" -c "SELECT ticker, mentions_now, vel_24h, sample_count, is_reliable FROM attention_velocity ORDER BY computed_at DESC LIMIT 10;"
```
Expected: rows present. On the **first** runs nearly everything will be
`is_reliable = false` with null velocities — there is no history yet. That is correct
behaviour, not a bug. Reliability appears only after ~3 hours of capture for
`MIN_SAMPLES`, and 24h/7d velocities only after 24h/7d of capture.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/attention-materialize.ts backend/src/services/attention-materialize.test.ts backend/src/attention-runner.ts
git commit -m "Materialize attention velocity rows on each capture"
```

---

## After the plan

1. Open a PR with all seven commits. Backend deploys to Railway automatically on merge
   to `main`.
2. The new cron must be **added as a service in the Railway dashboard** pointing at
   `railway.attention.toml` — Railway does not pick up new `.toml` files automatically.
   This is a manual step and the capture will not run without it.
3. Let it run for **2–4 weeks**. Then check gap coverage before trusting any metric:

```sql
SELECT date_trunc('hour', captured_at) h, count(DISTINCT ticker) tickers
  FROM attention_snapshots
 WHERE captured_at > now() - interval '7 days'
 GROUP BY 1 ORDER BY 1 DESC;
```
Expect ~2 runs per hour with a stable ticker count. Missing hours are gaps; a sudden
ticker-count drop is a source outage.

4. Only then plan Phase 3 (dashboard) and Phase 4 (`velocity_breakout` trading), using
   the measured distribution to calibrate `MIN_MENTIONS_NOW`, `MIN_BASELINE`, and the
   entry threshold. **The shipped floors are a starting position, not a calibration.**
