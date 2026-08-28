# No-Same-Day-Sell (Minimum Holding Period) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the auto-trader from selling a position on the same trading day it was opened. Add a guarded gate to `evaluateSell` keyed on the `America/New_York` calendar date, toggleable via a new `trading_config.no_same_day_sell` flag (default on).

**Architecture:** One pure, unit-tested helper `isSameTradingDay(entryDate, now)`; one guard at the top of `evaluateSell` (before stop-loss) that returns `HOLD` when the rule trips; one `TradingConfig` field + loader mapping; one DB migration. Bot-only — Screen 2 places buys only and is untouched.

**Tech Stack:** Node + TypeScript (tsx, NodeNext ESM with `.js` import specifiers), Postgres (`pg`), Vitest (added here — backend has no test runner yet).

**Spec:** `docs/superpowers/specs/2026-06-19-min-hold-no-same-day-sell-design.md`.

**Branch:** `trader/no-same-day-sell`.

---

## File Structure

- `backend/src/services/trade-restrictions.ts` — pure `isSameTradingDay`. New, single responsibility.
- `backend/src/services/trade-restrictions.test.ts` — Vitest unit tests.
- `backend/src/services/trader-unified.ts` — add `'min_hold'` to `ExitReason`; add the guard in `evaluateSell`.
- `backend/src/types/index.ts` — add `noSameDaySell: boolean` to `TradingConfig`.
- `backend/src/services/trader.ts` — map `no_same_day_sell` → `noSameDaySell` in `loadTradingConfig`.
- `backend/vitest.config.ts` + `backend/package.json` — test runner.
- `database/migration-015-min-hold.sql` — the config column.

---

## Task 1: Add Vitest to the backend

**Files:**
- Modify: `backend/package.json`
- Create: `backend/vitest.config.ts`
- Create: `backend/src/services/_smoke.test.ts` (temporary, deleted this task)

- [ ] **Step 1: Install Vitest**

Run from `backend/`:
```bash
npm install -D vitest@^3.0.0
```
Expected: added to devDependencies, no errors (repo uses `legacy-peer-deps=true`).

- [ ] **Step 2: Add the test script**

In `backend/package.json` `"scripts"`, add:
```json
"test": "vitest run"
```

- [ ] **Step 3: Create the Vitest config**

Create `backend/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Smoke test**

Create `backend/src/services/_smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('vitest', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run it**

Run from `backend/`: `npm test`
Expected: PASS, 1 test.

- [ ] **Step 6: Delete the smoke test and commit**

```bash
rm backend/src/services/_smoke.test.ts
git add backend/package.json backend/package-lock.json backend/vitest.config.ts
git commit -m "chore(backend): add vitest test runner"
```

---

## Task 2: Migration 015 — `no_same_day_sell` flag

**Files:**
- Create: `database/migration-015-min-hold.sql`

- [ ] **Step 1: Write the migration**

Create `database/migration-015-min-hold.sql`:
```sql
-- Migration 015: minimum holding period — block same-day sells (default ON)
ALTER TABLE trading_config
  ADD COLUMN IF NOT EXISTS no_same_day_sell BOOLEAN NOT NULL DEFAULT true;
```

- [ ] **Step 2: Apply to prod DB**

Run:
```bash
psql "$DATABASE_URL" -f database/migration-015-min-hold.sql
```
Expected: `ALTER TABLE` (or no error on re-run). If `psql` is unavailable, apply via a throwaway Node `pg` script (backend has `pg` + a `.env` with `DATABASE_URL`); delete the script after.

- [ ] **Step 3: Verify the column + default**

Run:
```bash
psql "$DATABASE_URL" -c "SELECT no_same_day_sell FROM trading_config WHERE id = 1;"
```
Expected: one row, value `t` (true).

- [ ] **Step 4: Commit**

```bash
git add database/migration-015-min-hold.sql
git commit -m "feat(db): add trading_config.no_same_day_sell flag (migration 015)"
```

---

## Task 3: Add `noSameDaySell` to TradingConfig + loader

**Files:**
- Modify: `backend/src/types/index.ts`
- Modify: `backend/src/services/trader.ts`

- [ ] **Step 1: Add the field to the type**

In `backend/src/types/index.ts`, in the `TradingConfig` interface (near `vetoLayerEnabled`), add:
```ts
  noSameDaySell: boolean;
```

- [ ] **Step 2: Map it in the loader**

In `backend/src/services/trader.ts`, inside `loadTradingConfig`, in the returned object (next to the `vetoLayerEnabled: (row.veto_layer_enabled as boolean) ?? false,` line), add:
```ts
    noSameDaySell: (row.no_same_day_sell as boolean) ?? true,
```
(Default `true` so the restriction is active even if the column is somehow absent.)

- [ ] **Step 3: Type-check**

Run from `backend/`: `npx tsc --noEmit`
Expected: no NEW errors from these two files. (If the repo has pre-existing unrelated errors, note them; the change itself must be clean. `TradingConfig` is now required to have `noSameDaySell`, so if any other code constructs a `TradingConfig` literal, tsc will flag it — fix those by adding `noSameDaySell: true` there, and report which.)

- [ ] **Step 4: Commit**

```bash
git add backend/src/types/index.ts backend/src/services/trader.ts
git commit -m "feat(trader): add noSameDaySell to TradingConfig + loader"
```

---

## Task 4: `isSameTradingDay` helper (pure, TDD)

**Files:**
- Create: `backend/src/services/trade-restrictions.ts`
- Test: `backend/src/services/trade-restrictions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/trade-restrictions.test.ts` (note: import WITHOUT the `.js` extension — Vitest resolves the `.ts`):
```ts
import { describe, it, expect } from 'vitest';
import { isSameTradingDay } from './trade-restrictions';

describe('isSameTradingDay', () => {
  it('true for two times a few hours apart on the same ET date', () => {
    // 2026-06-18 14:00 ET and 19:30 ET
    expect(isSameTradingDay('2026-06-18T18:00:00Z', new Date('2026-06-18T23:30:00Z'))).toBe(true);
  });

  it('false for entry vs the next ET morning', () => {
    // entry 2026-06-18 14:00 ET, now 2026-06-19 09:30 ET
    expect(isSameTradingDay('2026-06-18T18:00:00Z', new Date('2026-06-19T13:30:00Z'))).toBe(false);
  });

  it('false Friday -> Monday', () => {
    // 2026-06-19 is a Friday; 2026-06-22 Monday
    expect(isSameTradingDay('2026-06-19T18:00:00Z', new Date('2026-06-22T13:30:00Z'))).toBe(false);
  });

  it('UTC-vs-ET boundary: 02:00Z is the previous ET calendar day', () => {
    // 2026-06-19T02:00:00Z = 2026-06-18 22:00 ET; 2026-06-18T18:00:00Z = 14:00 ET -> same ET day
    expect(isSameTradingDay('2026-06-18T18:00:00Z', new Date('2026-06-19T02:00:00Z'))).toBe(true);
  });

  it('accepts a Date entryDate as well as a string', () => {
    expect(isSameTradingDay(new Date('2026-06-18T18:00:00Z'), new Date('2026-06-18T20:00:00Z'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run from `backend/`: `npm test -- trade-restrictions`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `backend/src/services/trade-restrictions.ts`:
```ts
/**
 * Format a timestamp to its America/New_York calendar date as YYYY-MM-DD.
 * en-CA locale yields ISO-style date parts.
 */
function etDateString(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * True when both timestamps fall on the same America/New_York calendar date.
 * Used to enforce the no-same-day-sell rule: a position opened on an ET date
 * cannot be sold again until a later ET date (the next session the bot runs).
 * Pure/deterministic; no external tz library.
 */
export function isSameTradingDay(entryDate: Date | string, now: Date): boolean {
  const entry = typeof entryDate === 'string' ? new Date(entryDate) : entryDate;
  if (Number.isNaN(entry.getTime())) return false;
  return etDateString(entry) === etDateString(now);
}
```

- [ ] **Step 4: Run to verify it passes**

Run from `backend/`: `npm test -- trade-restrictions`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/trade-restrictions.ts backend/src/services/trade-restrictions.test.ts
git commit -m "feat(trader): add isSameTradingDay helper with tests"
```

---

## Task 5: Add `min_hold` exit reason + the guard in `evaluateSell`

**Files:**
- Modify: `backend/src/services/trader-unified.ts`

- [ ] **Step 1: Import the helper**

At the top of `backend/src/services/trader-unified.ts`, with the other service imports, add:
```ts
import { isSameTradingDay } from './trade-restrictions.js';
```
(Note the `.js` extension — backend source uses NodeNext specifiers and runs via tsx.)

- [ ] **Step 2: Extend the `ExitReason` union**

Change the `ExitReason` type (currently around line 99) to include `'min_hold'`:
```ts
type ExitReason =
  | 'stop_loss'
  | 'catalyst_fade'
  | 'max_hold'
  | 'reclass_avoid'
  | 'scan_miss'
  | 'min_hold';
```

- [ ] **Step 3: Add the guard in `evaluateSell`**

In `evaluateSell`, immediately AFTER the line `const state = stateRows[0] ?? null;` and the `const daysHeld = ...` / `const category = ...` extractions, but BEFORE the `// 1. Stop-loss:` comment/check, insert:
```ts
  // 0. Minimum holding period: no sells (including stop-loss) on the entry
  // trading day. Earliest exit is the next ET session the bot runs.
  if (config.noSameDaySell && state?.entry_date && isSameTradingDay(state.entry_date, new Date())) {
    const wouldBeReason =
      position.unrealizedPlPct <= -stopLossPct ? 'stop_loss' : 'exit';
    return Object.assign(
      {
        ticker,
        action: 'HOLD' as const,
        scores,
        classification,
        tradeRationale: `Exit (${wouldBeReason}) suppressed: same-day sell blocked (no_same_day_sell).`,
      },
      { ...extras, exitReason: 'min_hold' as ExitReason }
    );
  }
```
Match the exact shape of the other `Object.assign(...)` HOLD/SELL returns in this function (copy the field set the neighboring `stop_loss` SELL return uses — `ticker`, `action`, `scores`, `classification`, `tradeRationale`, and the `extras` spread — so the returned `TradeDecision` is structurally identical to its siblings). If the sibling returns include additional required fields (e.g. `quantity`, `targetPrice`, `tier`), include them with the same values they use for a HOLD. Read the existing returns in `evaluateSell` first and mirror them precisely.

- [ ] **Step 4: Type-check**

Run from `backend/`: `npx tsc --noEmit`
Expected: no NEW errors from `trader-unified.ts`. If the HOLD return is missing a required `TradeDecision` field, tsc will say which — add it mirroring the sibling HOLD returns.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/trader-unified.ts
git commit -m "feat(trader): block same-day sells in evaluateSell (min_hold gate)"
```

---

## Task 6: Full verification

**Files:** none (verification)

- [ ] **Step 1: Run the backend unit suite**

Run from `backend/`: `npm test`
Expected: `trade-restrictions` tests pass (5), 0 failures.

- [ ] **Step 2: Type-check the whole backend**

Run from `backend/`: `npx tsc --noEmit`
Expected: no NEW errors introduced by this change (note any pre-existing unrelated ones).

- [ ] **Step 3: Confirm the migration is applied**

Run:
```bash
psql "$DATABASE_URL" -c "SELECT no_same_day_sell FROM trading_config WHERE id = 1;"
```
Expected: `t`.

- [ ] **Step 4: Logic spot-check (no orders placed)**

Confirm by reading `evaluateSell` that, with `noSameDaySell=true` and a position whose `entry_date` is today (ET), the function returns `HOLD`/`min_hold` and never reaches the stop-loss or max-hold branches. Note: the Railway trader cron is the deploy vehicle (it auto-deploys from `main` on merge) — no separate deploy step here; deployment happens when the branch merges.

---

## Self-Review

**Spec coverage:**
- §2 guard before stop-loss, blocks all exits same ET day, day-2+ unchanged → Task 5 ✓
- §3 pure `isSameTradingDay` (ET date, Intl, Date|string) → Task 4 ✓
- §4 migration + `TradingConfig.noSameDaySell` + loader default true → Tasks 2, 3 ✓
- §5 `'min_hold'` ExitReason + HOLD with note preserving would-be reason, persisted via existing trade_decisions path → Task 5 ✓
- §6 edge cases: `entry_date` null → not blocked (guard's `state?.entry_date &&`) ✓; bought-this-scan can't sell same pass ✓ (inherent); weekend/holiday implicit ✓
- §7 unit tests incl. UTC/ET boundary + Friday→Monday + Date input → Task 4 ✓
- Backend had no test runner → Task 1 adds Vitest ✓

**Placeholder scan:** every step has concrete code/commands; the one judgement point (mirroring sibling `TradeDecision` return fields) is explicitly instructed with a read-first directive rather than left vague. ✓

**Type consistency:** `noSameDaySell` (camel) ↔ `no_same_day_sell` (snake) used consistently across type/loader/migration; `isSameTradingDay` signature matches between helper, test, and the call site; `'min_hold'` added to the union before use. ✓

**Risk note:** Task 5's guard intentionally precedes and supersedes stop-loss on the entry day (per approved spec §2 / capital-risk decision). Not a bug.
