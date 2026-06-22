# Minimum Holding Period — No Same-Day Sell

**Date:** 2026-06-19
**Status:** Design approved, pending spec review
**Source request:** model a real-account constraint — "I wouldn't be allowed to buy and sell a stock within minutes/hours."

---

## 1. Summary

The auto-trading bot (`trader-unified.ts`) currently has max-hold and stop-loss exits but **no minimum hold** — it can buy and sell the same name on the same day (a day trade). On a real (non-PDT / cash) account that's restricted. This adds a **no-same-day-sell** rule: a position cannot be sold on the same trading day it was opened. The earliest exit is the next session the bot runs.

### Decisions locked during brainstorming

| Question | Decision |
|---|---|
| Restriction model | Minimum holding period (not PDT counting, not cash-settlement) |
| Threshold | No same-day sells — boundary is the `America/New_York` calendar date |
| Stop-loss | Blocked too (faithful): NO sells of any kind on the entry trading day |
| Scope | Auto-trader bot only (`evaluateSell`). Screen 2 only places buys → unaffected |
| Toggle | New `trading_config.no_same_day_sell` flag, default `true` |
| Implementation | Approach A — entry-day gate via ET calendar-date comparison |

---

## 2. Behavior

In `evaluateSell` (`backend/src/services/trader-unified.ts`), a guard runs **before the stop-loss check** (currently the first exit evaluated):

- If `config.noSameDaySell === true` **and** the position's `entry_date` is present **and** `isSameTradingDay(entry_date, now)` is true → return a `HOLD` decision. No exit (stop-loss, max-hold, reclassify-AVOID, catalyst-fade, scan-miss) fires this scan.
- Otherwise, the existing exit logic runs unchanged.

"Same trading day" = both timestamps fall on the same `America/New_York` calendar date. Because the pipeline cron only runs Mon–Fri during market hours (and not on holidays), the next ET date on which the bot runs is necessarily a later trading session — so weekends and holidays are handled implicitly with no holiday calendar needed.

Day 2+ behavior is completely unchanged: all existing exits work as before.

---

## 3. The pure helper

New module `backend/src/services/trade-restrictions.ts`:

```ts
/**
 * True when both timestamps fall on the same America/New_York calendar date.
 * Pure/deterministic; no external tz library (uses Intl with timeZone).
 */
export function isSameTradingDay(entryDate: Date | string, now: Date): boolean
```

Implementation: format each timestamp to a `YYYY-MM-DD` string in `America/New_York` via `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year, month, day })` (en-CA yields ISO-like `YYYY-MM-DD`), and compare the two strings. `entryDate` may be a `Date` or an ISO string (it arrives from `portfolio_state.entry_date`, a `TIMESTAMPTZ`); coerce a string via `new Date(entryDate)`.

This is the only new unit-tested logic.

---

## 4. Config flag

Migration `database/migration-015-min-hold.sql`:
```sql
ALTER TABLE trading_config
  ADD COLUMN IF NOT EXISTS no_same_day_sell BOOLEAN NOT NULL DEFAULT true;
```

- `TradingConfig` interface (`backend/src/types/index.ts:238`, next to `vetoLayerEnabled`) gains `noSameDaySell: boolean`.
- The loader (`backend/src/services/trader.ts:loadTradingConfig`, which maps DB columns ~line 68) maps `no_same_day_sell` → `noSameDaySell`, defaulting to `true` when absent (`(row.no_same_day_sell as boolean) ?? true`), the same defensive pattern as `vetoLayerEnabled`. `trader-unified.ts` re-exports this loader.
- Default `true` → the restriction is active on deploy. To disable: `UPDATE trading_config SET no_same_day_sell = false WHERE id = 1;`

---

## 5. Logging / visibility

- A new `ExitReason` value `'min_hold'`.
- When the gate suppresses an exit, the returned decision is `action: 'HOLD'` with `exitReason: 'min_hold'` and a human note such as:
  `"Exit (<would-be reason>) suppressed: same-day sell blocked (no_same_day_sell)"`.
- This persists to `trade_decisions` (which already stores HOLD rows), so the dashboard/DB shows exactly when and why an exit was held back. Capturing the would-be reason (e.g. `stop_loss`) in the note preserves the signal that the position *would* have stopped out.

---

## 6. Edge cases

- **`entry_date` null** (data gap): gate does NOT block; normal exit logic proceeds. Logged. In practice every real fill sets `entry_date`, so this is a defensive fallback, not an expected path.
- **Position bought this scan**: buys create new positions; sells only evaluate pre-existing positions, so a name can't be bought and sold in one `evaluate()` pass regardless. If re-evaluated later the same ET day, it is correctly blocked.
- **Weekend/holiday**: implicit — the next ET date the bot runs is a later session (bought Fri → earliest sell Mon).
- **UTC/ET boundary**: `entry_date` is `TIMESTAMPTZ`; the ET-date comparison is unambiguous (e.g., an entry at `02:00Z` is the previous ET calendar day, and the helper accounts for that via the `America/New_York` formatter).

---

## 7. Testing

Unit tests for `isSameTradingDay`:
- Same ET day: two timestamps a few hours apart on the same ET date → true.
- Different ET day: entry vs next ET morning → false.
- Friday → Monday → false (allowed).
- UTC-vs-ET edge: a timestamp at `2026-06-19T02:00:00Z` (= `2026-06-18` 22:00 ET) vs `2026-06-18T18:00:00Z` (= `2026-06-18` 14:00 ET) → same ET day → true.
- Across a same-ET-day evening: `2026-06-18T20:00:00Z` (16:00 ET) vs `2026-06-18T23:30:00Z` (19:30 ET) → true.

The `evaluateSell` integration (DB-backed, requires positions + config) is verified by inspection/manual run against the prod DB, consistent with how the existing sell path is validated. No new automated integration harness is introduced (YAGNI).

---

## 8. Files touched

- Create: `backend/src/services/trade-restrictions.ts` (+ `trade-restrictions.test.ts`)
- Modify: `backend/src/services/trader-unified.ts` — add the guard in `evaluateSell`, add `'min_hold'` to the `ExitReason` union, read `config.noSameDaySell`
- Modify: `backend/src/types/index.ts` — add `noSameDaySell: boolean` to `TradingConfig`
- Modify: `backend/src/services/trader.ts` — map `no_same_day_sell` → `noSameDaySell` in `loadTradingConfig`
- Create: `database/migration-015-min-hold.sql`

## 9. Out of scope

- PDT day-trade counting and cash-account settlement modeling (explicitly not chosen).
- Screen 2 entry analysis (places buys only).
- A holiday calendar (unnecessary given the cron schedule).
- Any change to buy-side logic or position sizing.
