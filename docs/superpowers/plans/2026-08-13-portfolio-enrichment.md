# Portfolio Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add entry dates, closed round trips with realized P/L, and a bot-behaviour panel to `/portfolio`, all derived from one round-trip episode ledger built from the `trades` table.

**Architecture:** A pure, I/O-free module walks filled trades per ticker keeping a running quantity, cutting a new "episode" each time quantity returns to zero. One API route runs the query and calls the module. Three views are projections of the resulting episode list. No new table, no migration.

**Tech Stack:** SvelteKit 2 + Svelte 5, TypeScript 5.7, vitest, node-postgres.

## Scope

Implements `docs/superpowers/specs/2026-08-13-portfolio-enrichment-design.md` in full.

## Global Constraints

- **No intervention tooling.** No distance-to-stop, no sell prompts, no alerts on open positions. This page audits the bot and reviews performance. The existing Sell button and Trade tab are left exactly as they are.
- **The episode ledger is the single source of truth for dates and durations.** Do not read `portfolio_state.entry_date` for entry date or days held.
- **Only `status='filled'` rows enter the ledger.** A pending order must never open an episode.
- **Realized P/L is GROSS.** No commission field exists and this is a paper account. Label it "gross" in the UI; never imply net.
- **An open episode has `realizedPl: null`, never `0`.** Null means unknown; zero is a claim it broke even.
- **ET dates only.** Any calendar-date logic uses `America/New_York` via `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })`. Never `toISOString().split('T')[0]` — that is the exact defect that hid the same-day-sell gate failure for five weeks.
- **`DECIMAL` columns arrive as strings.** node-postgres returns `filled_price` (DECIMAL(10,4)) as a string. It MUST be passed through `Number()` in the API route. `quantity` is INTEGER and arrives as a number.
- No new npm dependencies.
- `query()` from `$lib/db` returns **rows directly**, not a `{ rows }` wrapper.

## File Structure

| File | Responsibility |
|---|---|
| `web-dashboard/src/lib/portfolio/episodes.ts` | Pure. Trade rows → episodes → summaries → behaviour stats. No db, no fetch, no clock. |
| `web-dashboard/src/lib/portfolio/episodes.test.ts` | Unit tests for the above |
| `web-dashboard/src/routes/api/portfolio-history/+server.ts` | Query `trades`, call the pure module, return JSON |
| `web-dashboard/src/routes/portfolio/+page.svelte` | **Modify**: entry date + days held on positions; two new tabs |

---

### Task 1: Episode walk — the core ledger

**Files:**
- Create: `web-dashboard/src/lib/portfolio/episodes.ts`
- Test: `web-dashboard/src/lib/portfolio/episodes.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface TradeRow { ticker: string; action: 'BUY' | 'SELL'; quantity: number; filledPrice: number; filledAt: string; classification: string | null; rationale: string | null }`
  - `interface Episode { ticker; index; openedAt; closedAt; openEtDate; closeEtDate; peakQuantity; totalCost; totalProceeds; realizedPl; realizedPlPct; holdDays; isOpen; sameEtDay; classificationAtEntry; rationaleAtEntry }`
  - `interface EpisodeResult { episodes: Episode[]; anomalies: string[] }`
  - `etDateString(iso: string): string`
  - `buildEpisodes(trades: TradeRow[]): EpisodeResult`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web-dashboard && npx vitest run src/lib/portfolio/episodes.test.ts`

Expected: FAIL — `Failed to load url ./episodes`. A module-not-found error is **not** a valid RED. Create the file with the signatures below returning empty values, re-run, and confirm the failures become **assertion** failures before implementing:

```ts
export function etDateString(_iso: string): string { return ''; }
export function buildEpisodes(_t: TradeRow[]): EpisodeResult { return { episodes: [], anomalies: [] }; }
```

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Round-trip episode ledger.
 *
 * An episode is one time the bot was in a name: it opens on the buy that lifts
 * quantity off zero and closes when quantity returns to zero. Partial sells and
 * top-ups stay INSIDE the episode, because that is the unit the bot actually
 * decides in. FIFO lot matching was rejected in design: it fragments the observed
 * full-in/full-out pattern into rows corresponding to no decision.
 *
 * Pure module -- no db, no fetch, no clock.
 */

export interface TradeRow {
  ticker: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  filledPrice: number;
  /** ISO instant. */
  filledAt: string;
  classification: string | null;
  rationale: string | null;
}

export interface Episode {
  ticker: string;
  /** 0-based position of this episode within the ticker's history. */
  index: number;
  openedAt: string;
  closedAt: string | null;
  openEtDate: string;
  closeEtDate: string | null;
  peakQuantity: number;
  totalCost: number;
  totalProceeds: number;
  /** null while open -- never 0, which would claim it broke even. */
  realizedPl: number | null;
  realizedPlPct: number | null;
  holdDays: number | null;
  isOpen: boolean;
  sameEtDay: boolean;
  classificationAtEntry: string | null;
  rationaleAtEntry: string | null;
}

export interface EpisodeResult {
  episodes: Episode[];
  /** Tickers whose ledger would go negative. Surfaced, never silently dropped. */
  anomalies: string[];
}

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The America/New_York calendar date of an instant, as YYYY-MM-DD.
 * Never derive this from toISOString(): a 21:00 ET fill is the NEXT day in UTC,
 * and that off-by-one is what made the same-day-sell gate unreachable for five
 * weeks in production.
 */
export function etDateString(iso: string): string {
  return ET_DATE_FMT.format(new Date(iso));
}

/** Whole calendar days between two YYYY-MM-DD ET dates. */
function calendarDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export function buildEpisodes(trades: TradeRow[]): EpisodeResult {
  const byTicker = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const list = byTicker.get(t.ticker) ?? [];
    list.push(t);
    byTicker.set(t.ticker, list);
  }

  const episodes: Episode[] = [];
  const anomalies: string[] = [];

  for (const [ticker, rows] of byTicker) {
    rows.sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));

    let running = 0;
    let index = 0;
    let current: Episode | null = null;
    let negative = false;

    for (const t of rows) {
      if (t.action === 'BUY') {
        if (current === null) {
          current = {
            ticker,
            index,
            openedAt: t.filledAt,
            closedAt: null,
            openEtDate: etDateString(t.filledAt),
            closeEtDate: null,
            peakQuantity: 0,
            totalCost: 0,
            totalProceeds: 0,
            realizedPl: null,
            realizedPlPct: null,
            holdDays: null,
            isOpen: true,
            sameEtDay: false,
            classificationAtEntry: t.classification,
            rationaleAtEntry: t.rationale,
          };
        }
        running += t.quantity;
        current.totalCost += t.quantity * t.filledPrice;
        current.peakQuantity = Math.max(current.peakQuantity, running);
      } else {
        if (current === null) {
          // A sell with no open position: the ledger disagrees with reality.
          negative = true;
          break;
        }
        running -= t.quantity;
        current.totalProceeds += t.quantity * t.filledPrice;

        if (running < 0) {
          negative = true;
          break;
        }
        if (running === 0) {
          current.closedAt = t.filledAt;
          current.closeEtDate = etDateString(t.filledAt);
          current.isOpen = false;
          current.sameEtDay = current.openEtDate === current.closeEtDate;
          current.realizedPl = current.totalProceeds - current.totalCost;
          current.realizedPlPct =
            current.totalCost > 0 ? (current.realizedPl / current.totalCost) * 100 : null;
          current.holdDays = calendarDaysBetween(current.openEtDate, current.closeEtDate);
          episodes.push(current);
          current = null;
          index++;
        }
      }
    }

    if (negative) {
      anomalies.push(
        `${ticker}: sell quantity exceeds buys -- episodes omitted, ledger disagrees with reality`
      );
      // Drop every episode for this ticker: the whole walk is untrustworthy.
      for (let i = episodes.length - 1; i >= 0; i--) {
        if (episodes[i].ticker === ticker) episodes.splice(i, 1);
      }
      continue;
    }

    if (current !== null) episodes.push(current);
  }

  episodes.sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  return { episodes, anomalies };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web-dashboard && npx vitest run src/lib/portfolio/episodes.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add web-dashboard/src/lib/portfolio/episodes.ts web-dashboard/src/lib/portfolio/episodes.test.ts
git commit -m "Add round-trip episode ledger for portfolio history"
```

---

### Task 2: Closed-trip summary and behaviour statistics

**Files:**
- Modify: `web-dashboard/src/lib/portfolio/episodes.ts`
- Test: `web-dashboard/src/lib/portfolio/episodes.test.ts`

**Interfaces:**
- Consumes: `Episode` from Task 1
- Produces:
  - `interface ClosedSummary { count: number; realizedPl: number; winCount: number; lossCount: number; winRatePct: number | null; avgHoldDays: number | null }`
  - `interface BehaviourStats { reEntries: Array<{ ticker: string; episodes: number }>; sameDayByDate: Array<{ etDate: string; count: number }>; holdBuckets: Array<{ label: string; count: number }> }`
  - `summarizeClosed(episodes: Episode[]): ClosedSummary`
  - `behaviourStats(episodes: Episode[]): BehaviourStats`

- [ ] **Step 1: Write the failing tests**

```ts
import { summarizeClosed, behaviourStats } from './episodes';

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
    expect(s.winRatePct).toBeCloseTo(66.667, 2);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web-dashboard && npx vitest run src/lib/portfolio/episodes.test.ts -t 'summarizeClosed|behaviourStats'`
Expected: FAIL — `summarizeClosed is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `episodes.ts`:

```ts
export interface ClosedSummary {
  count: number;
  realizedPl: number;
  winCount: number;
  lossCount: number;
  winRatePct: number | null;
  avgHoldDays: number | null;
}

/**
 * Performance over CLOSED episodes only. Open positions are excluded entirely:
 * they have no realized result, and counting one as a zero would drag the win
 * rate down with a trade that has not finished happening.
 */
export function summarizeClosed(episodes: Episode[]): ClosedSummary {
  const done = episodes.filter((e) => !e.isOpen && e.realizedPl !== null);
  if (done.length === 0) {
    return { count: 0, realizedPl: 0, winCount: 0, lossCount: 0, winRatePct: null, avgHoldDays: null };
  }
  const realizedPl = done.reduce((sum, e) => sum + (e.realizedPl ?? 0), 0);
  const winCount = done.filter((e) => (e.realizedPl ?? 0) > 0).length;
  const lossCount = done.filter((e) => (e.realizedPl ?? 0) < 0).length;
  const holds = done.map((e) => e.holdDays ?? 0);
  return {
    count: done.length,
    realizedPl,
    winCount,
    lossCount,
    winRatePct: (winCount / done.length) * 100,
    avgHoldDays: holds.reduce((a, b) => a + b, 0) / holds.length,
  };
}

export interface BehaviourStats {
  reEntries: Array<{ ticker: string; episodes: number }>;
  sameDayByDate: Array<{ etDate: string; count: number }>;
  holdBuckets: Array<{ label: string; count: number }>;
}

/**
 * How the bot behaved, as opposed to how it performed. Re-entry counts and
 * same-day round trips are the signals that surfaced the no_same_day_sell gate
 * leak by hand on 2026-08-13; this makes them visible without writing SQL.
 */
export function behaviourStats(episodes: Episode[]): BehaviourStats {
  const perTicker = new Map<string, number>();
  for (const e of episodes) {
    perTicker.set(e.ticker, (perTicker.get(e.ticker) ?? 0) + 1);
  }
  const reEntries = [...perTicker.entries()]
    .map(([ticker, count]) => ({ ticker, episodes: count }))
    .sort((a, b) => b.episodes - a.episodes || a.ticker.localeCompare(b.ticker));

  const perDate = new Map<string, number>();
  for (const e of episodes) {
    if (!e.sameEtDay || !e.closeEtDate) continue;
    perDate.set(e.closeEtDate, (perDate.get(e.closeEtDate) ?? 0) + 1);
  }
  const sameDayByDate = [...perDate.entries()]
    .map(([etDate, count]) => ({ etDate, count }))
    .sort((a, b) => a.etDate.localeCompare(b.etDate));

  const buckets = [
    { label: 'same day', count: 0 },
    { label: '1-3d', count: 0 },
    { label: '4-7d', count: 0 },
    { label: '8d+', count: 0 },
  ];
  for (const e of episodes) {
    if (e.isOpen || e.holdDays === null) continue;
    if (e.holdDays === 0) buckets[0].count++;
    else if (e.holdDays <= 3) buckets[1].count++;
    else if (e.holdDays <= 7) buckets[2].count++;
    else buckets[3].count++;
  }

  return { reEntries, sameDayByDate, holdBuckets: buckets };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web-dashboard && npx vitest run src/lib/portfolio/episodes.test.ts`
Expected: PASS, 20 tests (12 from Task 1 plus 8 added here).

- [ ] **Step 5: Commit**

```bash
git add web-dashboard/src/lib/portfolio/episodes.ts web-dashboard/src/lib/portfolio/episodes.test.ts
git commit -m "Add closed-trip summary and bot-behaviour statistics"
```

---

### Task 3: API route

**Files:**
- Create: `web-dashboard/src/routes/api/portfolio-history/+server.ts`

**Interfaces:**
- Consumes: `buildEpisodes`, `summarizeClosed`, `behaviourStats` from Tasks 1–2
- Produces: `GET /api/portfolio-history` → `{ episodes, summary, behaviour, anomalies }`

- [ ] **Step 1: Write the route**

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/db';
import {
  buildEpisodes, summarizeClosed, behaviourStats, type TradeRow,
} from '$lib/portfolio/episodes';

interface TradeDbRow {
  ticker: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  filled_price: string | null;   // DECIMAL arrives as a STRING from node-postgres
  filled_at: Date | string;
  classification: string | null;
  trade_rationale: string | null;
}

export const GET: RequestHandler = async () => {
  try {
    // Only filled rows: a pending order must never open an episode.
    // COALESCE guards the handful of legacy rows with a null filled_at.
    const rows = await query<TradeDbRow>(
      `SELECT ticker, action, quantity, filled_price,
              COALESCE(filled_at, created_at) AS filled_at,
              classification, trade_rationale
         FROM trades
        WHERE status = 'filled'
        ORDER BY ticker, COALESCE(filled_at, created_at), id`
    );

    const trades: TradeRow[] = rows
      // A fill with no price cannot contribute a cost basis; skip rather than
      // treat it as free shares, which would invent profit.
      .filter((r) => r.filled_price !== null)
      .map((r) => ({
        ticker: r.ticker,
        action: r.action,
        quantity: Number(r.quantity),
        filledPrice: Number(r.filled_price),
        filledAt: new Date(r.filled_at).toISOString(),
        classification: r.classification,
        rationale: r.trade_rationale,
      }));

    const { episodes, anomalies } = buildEpisodes(trades);

    return json({
      episodes,
      summary: summarizeClosed(episodes),
      behaviour: behaviourStats(episodes),
      anomalies,
    });
  } catch (error) {
    console.error('portfolio-history error:', error);
    return json({ error: 'Failed to build portfolio history' }, { status: 500 });
  }
};
```

- [ ] **Step 2: Verify against real data**

Run:
```bash
cd web-dashboard && npm run dev -- --port 5202 &
sleep 12
curl -sS "http://localhost:5202/api/portfolio-history" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('episodes  :', len(d['episodes']))
print('open      :', sum(1 for e in d['episodes'] if e['isOpen']))
print('anomalies :', d['anomalies'])
print('summary   :', d['summary'])
"
```

Expected, verified against production on 2026-08-13:
- **600 episodes total, 6 open** — the open count MUST equal the live broker positions (CAVA, CSCO, LITE, ONDS, SMCI, SNDK). A different number means the walk is wrong; stop and investigate rather than adjusting the expectation.
- `anomalies` empty — no ticker has ever sold more than it bought.

Kill the dev server when done: `pkill -f "port 5202"`.

- [ ] **Step 3: Commit**

```bash
git add web-dashboard/src/routes/api/portfolio-history/+server.ts
git commit -m "Add portfolio-history API route"
```

---

### Task 4: Entry date and days held on the positions table

**Files:**
- Modify: `web-dashboard/src/routes/portfolio/+page.svelte`

**Interfaces:**
- Consumes: `GET /api/portfolio-history` from Task 3

- [ ] **Step 1: Fetch history alongside the existing calls**

In the `<script>` block, add the import and state:

```ts
import type { Episode, ClosedSummary, BehaviourStats } from '$lib/portfolio/episodes';

let episodes: Episode[] = [];
let summary: ClosedSummary | null = null;
let behaviour: BehaviourStats | null = null;
let historyAnomalies: string[] = [];
let historyError = '';

async function fetchHistory() {
  try {
    const res = await fetch('/api/portfolio-history');
    if (!res.ok) { historyError = 'Could not load trade history.'; return; }
    const data = await res.json();
    if (data.error) { historyError = data.error; return; }
    episodes = data.episodes;
    summary = data.summary;
    behaviour = data.behaviour;
    historyAnomalies = data.anomalies ?? [];
  } catch (e) {
    console.error('Failed to fetch portfolio history:', e);
    historyError = 'Could not load trade history.';
  }
}

/** Open episode per ticker, for entry date and days held on the positions table. */
$: openByTicker = new Map(episodes.filter((e) => e.isOpen).map((e) => [e.ticker, e]));

function daysSince(etDate: string): number {
  const from = Date.parse(`${etDate}T00:00:00Z`);
  const today = Date.parse(`${new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())}T00:00:00Z`);
  return Math.max(0, Math.round((today - from) / 86_400_000));
}
```

Add `fetchHistory()` to the existing `onMount` `Promise.all([...])` list.

- [ ] **Step 2: Add the columns**

In the positions `<thead>`, insert after the `Qty` header:

```svelte
              <th>Entry Date</th>
              <th>Held</th>
              <th>Entry Class</th>
```

In the `<tbody>` row, insert after the quantity `<td>`:

```svelte
                <td>{openByTicker.get(pos.ticker)?.openEtDate ?? '—'}</td>
                <td>
                  {#if openByTicker.get(pos.ticker)}
                    {daysSince(openByTicker.get(pos.ticker)!.openEtDate)}d
                  {:else}—{/if}
                </td>
                <td>{openByTicker.get(pos.ticker)?.classificationAtEntry ?? '—'}</td>
```

`classificationAtEntry` is populated on every filled buy in production (756/756 verified
2026-08-13), so a `—` here means no open episode was matched, not missing data.

- [ ] **Step 3: Verify in the browser**

Run: `cd web-dashboard && npm run dev -- --port 5202`, open `http://localhost:5202/portfolio`.

Expected: every open position shows an entry date and a day count. Cross-check two against the database:

```bash
psql "$DATABASE_URL" -c "
SELECT ticker, to_char(MAX(COALESCE(filled_at,created_at)) AT TIME ZONE 'America/New_York','YYYY-MM-DD') last_buy_et
  FROM trades WHERE action='BUY' AND status='filled'
   AND ticker IN ('SMCI','CAVA') GROUP BY ticker;"
```

A position whose entry date shows `—` means no open episode was found for it, which contradicts the broker — investigate rather than shipping the dash.

- [ ] **Step 4: Commit**

```bash
git add web-dashboard/src/routes/portfolio/+page.svelte
git commit -m "Show entry date and days held on open positions"
```

---

### Task 5: History tab — closed round trips

**Files:**
- Modify: `web-dashboard/src/routes/portfolio/+page.svelte`

**Interfaces:**
- Consumes: `episodes`, `summary` from Task 4

- [ ] **Step 1: Add the tab button**

After the existing `aiTrades` tab button:

```svelte
    <button class:active={activeTab === 'history'} on:click={() => activeTab = 'history'}>
      History ({summary?.count ?? 0})
    </button>
```

- [ ] **Step 2: Add the tab body**

After the `aiTrades` block:

```svelte
  {#if activeTab === 'history'}
    <div class="card">
      {#if historyError}
        <p class="note">{historyError}</p>
      {:else if summary && summary.count > 0}
        <div class="stats-grid">
          <div class="card stat-card">
            <div class="stat-value">{formatCurrency(summary.realizedPl)}</div>
            <div class="stat-label">REALIZED P/L (GROSS)</div>
          </div>
          <div class="card stat-card">
            <div class="stat-value">{summary.winRatePct?.toFixed(1) ?? '—'}%</div>
            <div class="stat-label">WIN RATE ({summary.winCount}W / {summary.lossCount}L)</div>
          </div>
          <div class="card stat-card">
            <div class="stat-value">{summary.avgHoldDays?.toFixed(1) ?? '—'}d</div>
            <div class="stat-label">AVG HOLD</div>
          </div>
          <div class="card stat-card">
            <div class="stat-value">{summary.count}</div>
            <div class="stat-label">ROUND TRIPS</div>
          </div>
        </div>
        <p class="note">
          Realized P/L is gross — the trades table records no commissions, and this is a
          paper account.
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th>Ticker</th><th>In</th><th>Out</th><th>Held</th>
              <th>Qty</th><th>Cost</th><th>Proceeds</th><th>Realized</th>
            </tr>
          </thead>
          <tbody>
            {#each episodes.filter((e) => !e.isOpen) as ep}
              <tr>
                <td><a href="/ticker/{ep.ticker}"><strong>{ep.ticker}</strong></a></td>
                <td>{ep.openEtDate}</td>
                <td>{ep.closeEtDate}</td>
                <td>{ep.holdDays}d{#if ep.sameEtDay} <span class="note">same day</span>{/if}</td>
                <td>{ep.peakQuantity}</td>
                <td>{formatCurrency(ep.totalCost)}</td>
                <td>{formatCurrency(ep.totalProceeds)}</td>
                <td class={(ep.realizedPl ?? 0) >= 0 ? 'positive' : 'negative'}>
                  {formatCurrency(ep.realizedPl ?? 0)}
                  ({formatPercent(ep.realizedPlPct ?? 0)})
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="note">No closed round trips yet.</p>
      {/if}
    </div>
  {/if}
```

Note: `positive` / `negative` classes and `formatCurrency` / `formatPercent` already exist in this file — reuse them, do not redefine.

- [ ] **Step 3: Verify in the browser**

Expected: ~594 closed round trips, summary tiles populated, SNDK visible with multiple separate round trips.

- [ ] **Step 4: Commit**

```bash
git add web-dashboard/src/routes/portfolio/+page.svelte
git commit -m "Add closed round-trip history tab"
```

---

### Task 6: Behaviour tab

**Files:**
- Modify: `web-dashboard/src/routes/portfolio/+page.svelte`

**Interfaces:**
- Consumes: `behaviour`, `historyAnomalies` from Task 4

- [ ] **Step 1: Add the tab button**

```svelte
    <button class:active={activeTab === 'behaviour'} on:click={() => activeTab = 'behaviour'}>
      Behaviour
    </button>
```

- [ ] **Step 2: Add the tab body**

```svelte
  {#if activeTab === 'behaviour'}
    <div class="card">
      {#if historyAnomalies.length > 0}
        <p class="note detail">Ledger anomalies: {historyAnomalies.join('; ')}</p>
      {/if}
      {#if behaviour}
        <h3>Same-day round trips</h3>
        <p class="note">
          A position opened and closed on the same ET date. The no_same_day_sell gate was
          made to work over three fixes ending 2026-08-10; entries on or before that date
          are the pre-fix era.
        </p>
        <table class="data-table">
          <thead><tr><th>ET Date</th><th>Count</th><th></th></tr></thead>
          <tbody>
            {#each behaviour.sameDayByDate as d}
              <tr>
                <td>{d.etDate}</td>
                <td>{d.count}</td>
                <td>{d.etDate <= '2026-08-10' ? 'pre-fix' : ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>

        <h3>Most re-entered</h3>
        <table class="data-table">
          <thead><tr><th>Ticker</th><th>Episodes</th></tr></thead>
          <tbody>
            {#each behaviour.reEntries.slice(0, 15) as r}
              <tr>
                <td><a href="/ticker/{r.ticker}"><strong>{r.ticker}</strong></a></td>
                <td>{r.episodes}</td>
              </tr>
            {/each}
          </tbody>
        </table>

        <h3>Hold duration</h3>
        <table class="data-table">
          <thead><tr><th>Bucket</th><th>Count</th></tr></thead>
          <tbody>
            {#each behaviour.holdBuckets as b}
              <tr><td>{b.label}</td><td>{b.count}</td></tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="note">No trade history yet.</p>
      {/if}
    </div>
  {/if}
```

- [ ] **Step 3: Verify in the browser and against the database**

The same-day table's post-2026-08-10 rows must be empty. Cross-check:

```bash
psql "$DATABASE_URL" -c "
WITH t AS (
  SELECT ticker, action, quantity, filled_at,
         sum(CASE WHEN action='BUY' THEN quantity ELSE -quantity END)
           OVER (PARTITION BY ticker ORDER BY filled_at, id) AS running
    FROM trades WHERE status='filled'),
marked AS (
  SELECT *, COALESCE(sum(CASE WHEN running=0 THEN 1 ELSE 0 END)
           OVER (PARTITION BY ticker ORDER BY filled_at
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS episode
    FROM t)
SELECT count(*) FILTER (WHERE open_et = close_et) AS same_day_total
  FROM (SELECT (min(filled_at) AT TIME ZONE 'America/New_York')::date open_et,
               (max(filled_at) AT TIME ZONE 'America/New_York')::date close_et,
               bool_or(running=0) closed_out
          FROM marked GROUP BY ticker, episode) e
 WHERE closed_out;"
```

Expected: 481, matching the sum of the counts shown in the UI table.

- [ ] **Step 4: Run the full suite and build**

Run: `cd web-dashboard && npm test && npm run build`
Expected: all tests PASS (45 existing + 20 new = 65), build succeeds. The build emits a
pre-existing `pg-native` / `cloudflare:sockets` dependency warning — that is normal and
not caused by this work.

- [ ] **Step 5: Commit**

```bash
git add web-dashboard/src/routes/portfolio/+page.svelte
git commit -m "Add bot-behaviour tab with re-entries and same-day round trips"
```

---

## After the plan

1. `/portfolio` changes do **not** reach production automatically. The dashboard does not auto-deploy from GitHub — someone must run `vercel --prod` from `web-dashboard/`. Production is currently serving a bundle from 2026-06-18.
2. The same-day round-trip table is now the standing monitor for the `no_same_day_sell` gate. Any new row dated after 2026-08-10 is a regression and should be investigated against `trade_decisions`, where the gate logs its blocks.
