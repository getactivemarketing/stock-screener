# Portfolio Enrichment — Design

**Goal:** Make `/portfolio` answer two questions it currently cannot: *is the bot
behaving sensibly*, and *how is the money actually doing*. Every addition derives from
one new artifact — a round-trip episode ledger built from the `trades` table.

**Status:** design approved 2026-08-13. Not yet planned or implemented.

## Motivation

The positions table today shows ticker, quantity, average cost, last price, market
value, and P/L. That is a snapshot with no time axis: it cannot say when a position was
opened, how long the bot has held it, what it did on the way here, or whether any
closed position ever made money. Realized performance does not exist anywhere in the
schema — there is no realized-P/L column and no closed-position table.

The gap is not cosmetic. On 2026-08-13 the `no_same_day_sell` gate had to be audited by
hand-writing SQL against `trades`, because nothing in the UI could show that nine
positions had been opened and closed inside 40 minutes. That audit is exactly what this
feature makes routine.

## Scope

Three views, all fed by the same ledger:

1. **Open positions** — entry date and days held added to the existing table.
2. **Closed round trips** — every completed episode with dates, duration, realized P/L.
3. **Bot behaviour** — re-entry counts, same-day round trips over time, hold-duration
   distribution.

### Non-goals

**No intervention tooling.** No distance-to-stop, no "should I sell" prompts, no alerts
on open positions. The user was explicit: this page is for auditing the machine and
reviewing performance, not for deciding manual trades. The existing Sell button and
Trade tab stay as they are; nothing new is added in that direction.

Also out of scope: changing how the bot trades, backfilling historical
`portfolio_state` rows, and adding a commission model.

## The episode ledger

The single derived artifact. Everything else is a projection of it.

**Definition.** Walk one ticker's filled trades in fill order, maintaining a running
quantity. An episode opens on the first buy that lifts quantity off zero and closes on
the fill that returns it to zero. Partial sells and top-ups stay *inside* the episode —
an episode is "one time I was in this name", which is the unit the bot actually decides
in, and matches `portfolio_state.entry_date` semantics (reset on re-entry).

FIFO lot matching was considered and rejected: it fragments the observed full-in /
full-out pattern into rows that correspond to no decision the bot made.

**Per episode:** ticker, entry date (ET), exit date (ET) or open, hold duration, peak
quantity, total cost, total proceeds, realized P/L (closed only).

**Validated against production 2026-08-13:**
- 116 tickers, 193,400 shares bought vs 191,373 sold.
- Net 2,027 shares reconciles exactly with the six open broker positions
  (CAVA 176, CSCO 98, LITE 14, ONDS 1365, SMCI 367, SNDK 7).
- **No ticker has ever sold more than it bought**, so the running quantity never goes
  negative and episode boundaries are unambiguous.
- The walk yields **594 closed episodes and 6 open** — the open count matching the six
  broker positions is an independent check that the boundaries are correct.
- 481 episodes opened and closed on the same ET date: 478 before 2026-08-10, 3 on
  2026-08-10 itself (all before the 11:20 ET fix), **zero since**.

`entry_date` on the open episode was cross-checked against actual BUY fills for all six
positions and matched exactly, so the ledger and `portfolio_state` agree.

### Correctness rule: reconstruct episodes, never pair trades

Same-day round trips MUST be derived from episode boundaries, not by joining any BUY to
any later SELL on the same date. The naive pairing counts "sell yesterday's shares and
open a new position today" as a round trip. During the 2026-08-13 audit the naive query
reported 19 post-fix same-day round trips; episode reconstruction showed 9. Over all
history the naive count is 1,348 against a true 481. The difference is entirely false
positives, and it is large enough to change conclusions.

## Architecture

**Derive on read.** A pure module transforms trade rows into episodes; one API route
serves the projections. No new table, no migration, no refresh job.

This deliberately differs from the attention-velocity design, which materializes. That
feature freezes what a trading decision saw at decision time. This one is reporting over
an immutable ledger — `trades` rows do not change after fill, so recomputation is
always identical. Materializing later remains easy and nothing downstream depends on
the choice.

Scale is not a concern: ~2,000 filled trades total.

### Module boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `web-dashboard/src/lib/portfolio/episodes.ts` | Pure. Trade rows → episodes → summaries. No db, no fetch, no clock. | nothing |
| `web-dashboard/src/lib/portfolio/episodes.test.ts` | Unit tests for the above | vitest |
| `web-dashboard/src/routes/api/portfolio-history/+server.ts` | Query `trades`, call the pure module, return JSON | db, episodes.ts |
| `web-dashboard/src/routes/portfolio/+page.svelte` | Two new tabs; entry date + days held on positions | the API route |

The pure module takes `now` as a parameter so every behaviour is reproducible in a test
— the same discipline used in `attention-velocity.ts`.

## Data sources and traps

**The episode ledger is the single source of truth for dates and durations.** Entry
date, exit date, and days held all come from the walk over `trades`. `portfolio_state`
is NOT read for these — it was used only to validate the ledger during design (all six
open positions agreed), and introducing it as a second source would mean two fields that
can silently disagree.

| Field | Source | Note |
|---|---|---|
| entry date, exit date, days held | `trades.filled_at` via episode walk | authoritative |
| realized P/L | episode proceeds − cost | **gross** |
| re-entry count | episodes per ticker | |
| classification at entry, rationale | `trades.classification`, `trade_rationale` | first buy of the episode |

`portfolio_state` is not read at all. It was considered as a fallback for
`classification_at_entry`, but that is unnecessary: `trades.classification` is populated
on 756 of 756 filled buys (verified 2026-08-13), so the ledger alone is sufficient.

**Trap 1 — timezone.** Every ET-date grouping over `filled_at` must use
`AT TIME ZONE 'America/New_York'`, and if `portfolio_state.entry_date` is ever read it
MUST go through `to_char(entry_date, 'YYYY-MM-DD')` — that column is a bare `DATE`, and
letting the node-postgres driver parse it yields midnight UTC = 20:00 ET the previous
day. That is the exact defect that made the same-day-sell gate unreachable for five
weeks, so it is treated as a standing rule, not a caution.

**Trap 2 — gross, not net.** No commission or fee field exists in `trades`, and this is
an Alpaca paper account. Realized P/L is labelled "gross" in the UI rather than implying
a net figure.

**Trap 3 — pending and non-filled orders.** Only `status='filled'` rows enter the
ledger. A pending buy must never open an episode.

## Views

**Positions tab (extended).** Adds entry date, days held, and classification at entry.

**History tab (new).** Closed episodes, newest first, with a summary header: total
realized P/L, win rate, average hold duration, episode count.

**Behaviour tab (new).** All-time, with a marker at the 2026-08-10 gate fix so the
before/after contrast stays legible:
- same-day round trips over time (478 before 2026-08-10, 3 on the fix date itself, zero
  since)
- re-entry counts per ticker (ONDS leads with repeated full in/out cycles)
- hold-duration distribution

## Error handling

- A ticker whose walk would go negative is **skipped and reported**, not silently
  dropped or clamped. It cannot happen with current data; if it ever does, it means the
  ledger disagrees with reality and hiding it would be the wrong answer.
- No filled trades → empty views with an explanatory empty state, not an error.
- An open episode has `realizedPl: null`, never `0`. Null means "not yet known"; zero is
  a claim that it broke even.
- The API route follows the existing convention: DB failure returns an error payload the
  page renders as a message, rather than a blank table.

## Testing

Pure-module unit tests, TDD, covering:
- single buy → single sell = one closed episode with correct P/L
- partial sell then top-up stays ONE episode until flat
- buy → sell → re-buy = two episodes, second still open
- an open episode reports `realizedPl: null` and no exit date
- same-day detection uses ET dates, and a position opened 19:00 ET and sold 09:30 ET the
  next day is NOT same-day
- empty input returns empty, does not throw
- a would-go-negative ledger is surfaced rather than swallowed

The ONDS and SNDK histories are used as real-data fixtures — both have multi-episode
patterns already verified against production.

## Open questions

None. Partial-sell handling (episode stays open until flat) and history window (all
time, with fix marker) were decided 2026-08-13.
