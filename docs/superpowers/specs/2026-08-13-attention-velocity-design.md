# Attention Velocity — Design Spec

**Date:** 2026-08-13
**Status:** Approved, not implemented
**Repo:** getactivemarketing/stock-screener

This spec is written to be self-contained. An implementer with no prior conversation
context should be able to work from it alone.

---

## 1. Why

The screener scores attention as a **level** (`attention_score` 0–100, driven by mention
count, sentiment, ApeWisdom rank). It does not measure how fast attention is **changing**.

A stock at 1,500 mentions that was at 1,600 yesterday scores high and is decaying. A stock
at 180 mentions that was at 30 yesterday scores low and is where the opportunity is. The
current system prefers the first and is blind to the second.

Supporting evidence from outside the project: raw social sentiment correlates weakly with
price, while **comment volume and search activity** are stronger signals, and *changes* in
volume outperform sentiment alone. The metric to build is therefore change-in-volume, not
more sentiment analysis.

## 2. The blocker that shapes everything

`pipeline-unified.ts` merges all sentiment sources into a full universe
(`mergeSentimentByTicker`), then truncates to `MAX_CANDIDATES = 40` at line ~447, enriches,
filters, and persists roughly 18 rows to `scan_results`.

**The full merged universe is discarded every 30 minutes.**

`scan_results` has 7 months of history (34,826 rows / 2,538 runs / 914 tickers, since
2026-01-20) including `total_mentions`, `apewisdom_mentions`, `apewisdom_rank`,
`source_count`, `avg_sentiment`. But a ticker only appears there **after it already made
the cut**.

This is fatal to velocity as an early-warning signal. A stock going 30 → 180 mentions was
nowhere near the top 40 at 30 mentions, so there is no "before" value to compare against.
The system can currently only measure acceleration for stocks it had already noticed.

**Capturing the full universe is a prerequisite, not an enhancement.** It is Phase 1.

A second constraint: the pipeline cron is `*/30 14-22 * * 1-5` — weekdays, 10:00–18:30 ET
only. No overnight, no weekends. That is precisely when retail attention builds on forums.
Capture must run on its own 24/7 schedule.

## 3. Decisions taken

| Question | Decision |
|---|---|
| What does velocity drive? | Dashboard **and** a trading entry signal |
| How does it enter trading? | A new entry category `velocity_breakout`, isolated from the existing four |
| Capture window | Separate lightweight 24/7 cron |
| Data sources | Existing only (ApeWisdom, Stocktwits, Finviz, Reddit, Swaggy). No Google Trends, no news monitoring in v1 |
| Storage | Raw time series **plus** a materialized velocity table |

Rejected: computing velocity on read only (no audit trail of what the trader saw);
storing rolling aggregates without raw (cannot change the formula retroactively or
re-validate against history — unacceptable for an unvalidated signal).

## 4. Architecture

### Phase 1 — Capture

New service `backend/src/services/attention-capture.ts`, run by a new Railway cron
(`railway.attention.toml`, `RUN_MODE=attention`) on `*/30 * * * *`, 24/7.

It calls the existing sentiment services **only**. No Finnhub, no Yahoo, no classifier, no
AI enrichment. Those are the expensive, rate-limited calls; omitting them is what makes
round-the-clock capture affordable.

```sql
CREATE TABLE attention_snapshots (
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
CREATE INDEX idx_att_snap_ticker_time ON attention_snapshots (ticker, captured_at DESC);
CREATE INDEX idx_att_snap_time        ON attention_snapshots (captured_at DESC);
```

`ticker VARCHAR(10)` matches every other ticker column in the schema. Do not widen it.

### Phase 2 — Velocity computation and materialization

New pure module `backend/src/services/attention-velocity.ts`, **no I/O**, matching the
existing pure-module pattern of `earnings-window.ts` and `day-trade-guard.ts`.

```ts
export interface Snapshot {
  capturedAt: Date;
  mentions: number;
  sourcesPresent: string[];
}

export interface VelocityMetrics {
  vel1h: number | null;
  vel6h: number | null;
  vel24h: number | null;
  vel7d: number | null;
  acceleration: number | null;
  baselineMentions: number | null;
  sampleCount: number;
  isReliable: boolean;
}

export function velocityAt(series: Snapshot[], now: Date, windowHours: number): number | null;
export function acceleration(series: Snapshot[], now: Date): number | null;
export function baseline(series: Snapshot[], days: number): number | null;
export function computeVelocity(series: Snapshot[], now: Date): VelocityMetrics;
```

Definitions, stated explicitly so they cannot be interpreted two ways:

- **`baseline(series, days)`** — the mean of `mentions` over the trailing `days` window,
  excluding the most recent hour so a live spike does not inflate its own baseline.
  Default window: 7 days.
- **`velocityAt(series, now, windowHours)`** — percentage change against the snapshot
  nearest `now - windowHours`:
  `(mentionsNow - mentionsThen) / max(mentionsThen, MIN_BASELINE) * 100`.
  Denominator is floored by `MIN_BASELINE` so a near-zero prior value cannot produce an
  unbounded result. Returns `null` on gap or source-set mismatch.
- **`acceleration(series, now)`** — change in velocity itself: `vel1h - previousVel1h`,
  where `previousVel1h` is the 1h velocity computed as of `now - 1h`. Expressed in
  percentage points. Returns `null` if either 1h velocity is `null`.
- **`sampleCount`** — number of snapshots present in the trailing 7-day window.

Materialized output, one row per ticker per capture run:

```sql
CREATE TABLE attention_velocity (
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
CREATE INDEX idx_att_vel_time ON attention_velocity (computed_at DESC);
CREATE INDEX idx_att_vel_ticker_time ON attention_velocity (ticker, computed_at DESC);
```

This table is the frozen record of **what the trader saw at decision time** — the same
reason `config_snapshot` and `entry_composite` are written onto entry rows today. When a
`velocity_breakout` entry goes wrong, the exact triggering numbers must be recoverable
without recomputation against data that has since changed.

### Phase 3 — Dashboard

`web-dashboard/src/routes/radar/+page.svelte` and `api/radar/+server.ts`. Ranked by 24h
velocity. Reliability shown explicitly. Mentions-now displayed alongside baseline so a
spike is legible as counts, not only as a percentage.

### Phase 4 — Trading (ships dark)

- Add `velocity_breakout` to the `EntryCategory` union in `backend/src/types/index.ts`.
- Add `CATEGORY_MAX_HOLD_DAYS.velocity_breakout = 5` in `trader-unified.ts` (attention
  decays fast; this is deliberately the shortest horizon of the five categories).
- New config columns: `velocity_breakout_enabled BOOLEAN NOT NULL DEFAULT false`,
  `velocity_min_24h_pct NUMERIC`, `velocity_min_mentions INTEGER`.
- Entry requires **all** of: `is_reliable`, `vel_24h >= velocity_min_24h_pct`, and every
  existing risk check.
- Position sizing uses the **speculative tier**, not core. This is an unvalidated signal
  and must not take full-size positions.
- All six existing guards apply unchanged: overnight hold, sell→rebuy, duplicate-buy,
  committed-capital limits (8 positions / 85% heat), pre-earnings exit, long-only.

Ships with the flag **off**, following the `pre_earnings_exit_days` precedent. Nothing
trades until the flag is deliberately flipped.

## 5. Correctness properties

These are the requirements most likely to be got wrong. Each needs a test.

### 5.1 Source-set mismatch (highest severity)

If ApeWisdom is down for one run, affected tickers' mention counts collapse toward zero.
Velocity then reads **−100%, and +∞ on recovery**. Every source outage would manufacture a
fake breakout, and Phase 4 would trade it.

**Requirement:** velocity is computed only across the **intersection of sources present at
both endpoints** of the comparison. A snapshot pair whose `sources_present` sets differ is
marked `is_reliable = false` rather than silently compared.

### 5.2 The small-number trap

1 → 6 mentions is "+500%". So is 30 → 180. The first is noise; without an absolute floor,
noise ranks top of the radar every run and dominates the trading signal.

**Requirement:** `is_reliable` encodes floors. No consumer may act on a metric with
`is_reliable = false`.

Ship these conservative defaults, exported as named constants so they are trivially
tunable once Phase 1 has produced real data:

```ts
export const MIN_MENTIONS_NOW = 25;   // below this, percentage change is noise
export const MIN_BASELINE     = 5;    // baseline near zero makes any ratio explode
export const MIN_SAMPLES      = 6;    // ~3h of coverage at 30-min cadence
```

`isReliable` is true only when all three hold **and** the source-set rule in 5.1 is
satisfied. Under these defaults 1 → 6 is unreliable (fails `MIN_MENTIONS_NOW`) while
30 → 180 is reliable, which is the intended boundary. These numbers are a starting
position, not a calibrated result — revisit after Phase 1.

### 5.3 Gaps are gaps

A missed capture run (API failure, deploy, Railway restart) leaves a hole. Interpolating
across it invents data.

**Requirement:** nearest-snapshot matching within an explicit tolerance; outside tolerance
return `null`. Never interpolate. A partial capture must not write partial rows — log
loudly and skip, so a gap stays visible.

Tolerance is proportional to the window, floored so short windows stay usable:

```ts
export const TOLERANCE_FRACTION = 0.25;              // 25% of the requested window
export const MIN_TOLERANCE_MINUTES = 45;             // ~1.5 capture intervals
// 1h window  -> 45 min tolerance (floor applies)
// 24h window -> 6h tolerance
```

If the nearest snapshot to `now - windowHours` falls outside that tolerance, the metric for
that window is `null`. A `null` for one window does not invalidate the others.

### 5.4 Timezone discipline

This project has been bitten three times by date handling. `TIMESTAMPTZ` columns compared
in UTC are safe; any calendar-date grouping must use
`to_char(col AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')`. The node-postgres driver
parses bare `DATE` columns at process-timezone midnight, which on a UTC container is
20:00 ET the previous day.

## 6. Testing

TDD throughout — write the failing test, watch it fail for the right reason, then
implement. Pure functions in `attention-velocity.ts` are fully unit-testable with no
mocking. Required cases:

- source-set mismatch marks unreliable, does not compare
- source outage does not produce a −100% / +∞ pair
- 1 → 6 mentions is unreliable; 30 → 180 is evaluated at the reliability boundary
- gap beyond tolerance returns null, never interpolates
- baseline over a window with missing samples
- acceleration sign and magnitude
- empty series, single-sample series, all-zero series
- DST boundary on a 24h window

## 7. Phasing and gates

| Phase | Ships | Gate to proceed |
|---|---|---|
| 1 Capture | Table, service, cron | Runs 24/7 for 2–4 weeks without gaps |
| 2 Velocity | Pure module, materialized table | Metrics stable; floors calibrated on real data |
| 3 Dashboard | `/radar` | Spikes visibly precede real moves |
| 4 Trading | `velocity_breakout`, flag **off** | Evidence from Phase 3 before flipping the flag |

**Velocity cannot be traded until history exists.** 24h and 7d windows need 24h and 7d of
data; the baseline needs more. Phase 4's code ships before its evidence does, which is why
it ships dark.

## 8. Explicitly out of scope for v1

- Google Trends and news/catalyst monitoring (deferred to v2; adds three integrations)
- Retention and rollup policy — the universe size is **unmeasured**. The pipeline logs it
  (`${Object.keys(merged).length} unique tickers`) but does not store it. The first
  implementation task is to measure it. At an estimated ~500 tickers × 48 runs/day this is
  ~9M rows/year, which Postgres handles, but retention should be designed against a
  measured number rather than a guessed one.
- The "Opportunity Score", multi-lens scoring, and "Why Now?" explainability. Note that
  lenses already partially exist as `entry_category` and are simply not surfaced in the UI.
- Auto-publishing signals to social media. Out of scope here, and it carries an unresolved
  conflict: posting about a ticker the system holds is promotion of a held position.

## 9. Project traps an implementer must know

- `trade_decisions` contains only `SKIP` and `HOLD` rows. Real orders are in `trades`.
- `exit_reason` is written on the **BUY** row of a round trip, never the SELL row.
- Current holdings require filtering **after** the `DISTINCT ON`:
  `SELECT * FROM (SELECT DISTINCT ON (ticker) * FROM portfolio_state ORDER BY ticker, created_at DESC) x WHERE quantity > 0`
- Any analysis window crossing **2026-08-03** is contaminated by a corrupted `days_held`
  bug repaired that day. Always split at that date.
- `trades` columns are `filled_price` / `filled_at` (not `filled_avg_price`).
- The dashboard deploys by **manual `vercel --prod`** from `web-dashboard/`. It does not
  auto-deploy from git.
- Backend deploys to Railway automatically on merge to `main`.
