# Guard throughput & exit-mix audit

A reusable analysis spec for answering two questions about the trading bot:

1. **Is the bot still able to trade**, or have the guards compounded into a de-facto freeze?
2. **Did removing an exit rule reduce churn**, or did the churn move to another exit reason?

Originally written as a scheduled cloud routine. **It cannot run as a cloud routine** —
the sandbox's egress proxy permits only inspectable HTTPS and Postgres speaks raw TCP, so
`psql` times out and a wire-protocol tunnel through the CONNECT proxy is killed. Run it
from a session that already has database access. Do not paste a connection string into a
routine prompt; it will not work and it leaks the credential into cloud config and run logs.

## Schema facts you MUST respect

Each of these has produced a wrong answer before.

1. `trade_decisions` contains ONLY `action='SKIP'` and `'HOLD'`. There are NO `'BUY'` rows.
   Real orders live in `trades` (`action='BUY'/'SELL'`, `status='filled'/'cancelled'/'pending'`).
   Counting buys from `trade_decisions` returns zero and is wrong.
2. `exit_reason` is written on the **BUY** row of a round trip, NEVER the SELL row.
   Querying it on SELL rows returns all NULL.
3. ALWAYS read dates as `to_char(col AT TIME ZONE 'America/New_York','YYYY-MM-DD')`. The pg
   driver parses bare DATE columns at process-timezone midnight, which on a UTC container is
   20:00 ET the PREVIOUS day.
4. Current holdings from `portfolio_state` require filtering AFTER the `DISTINCT ON`:
   ```sql
   SELECT * FROM (SELECT DISTINCT ON (ticker) * FROM portfolio_state
                   ORDER BY ticker, created_at DESC) x WHERE quantity > 0
   ```
   Filtering inside the subquery returns every ticker ever held (111 instead of 6).
5. `trades` columns are `filled_price` and `filled_at` (NOT `filled_avg_price`). There is no
   `days_held` or `realized_pl` on `trades`; those live on `portfolio_state`.
6. Any window longer than ~10 days is CONTAMINATED by a corrupt `days_held` bug repaired on
   2026-08-03. Always split at 2026-08-03. A 30-day window showed `max_hold` as the dominant
   exit (131); post-fix it had fired 3 times.
7. Same-day round trips must be derived from **flat-to-flat episode reconstruction**, never by
   pairing any BUY with any later SELL on the same date. Naive pairing counts "sell yesterday's
   shares + open a new position today" as a round trip and overstates by ~3× (1,348 vs 481).

## Guard reason strings in `trade_decisions.reason`

| Guard | Pattern |
|---|---|
| min_hold | `%same-day sell blocked%` (action HOLD) |
| sell→rebuy | `%sold today%` |
| pending duplicate | `%pending%order%` |
| max positions | `%Max positions%` |
| heat | `%heat%` |
| long-only | `%non-long%` |
| buying power | `%buying power%` |

Merit-based rejections are NOT guards — keep them separate: `%Composite%< %`,
`%Conviction%< %`, `%Not tradeable%`.

## The report

1. Filled BUY count per ET day, last 12 days. Is the recent run rate below baseline?
2. Exit mix by `exit_reason` for the recent window vs baseline. Did total exits fall?
3. Confirm a removed exit rule is dead: any `trades` BUY row with that `exit_reason` and
   `updated_at` after the removal timestamp. Report the count explicitly either way.
4. sell→rebuy guard blocks per day. **The main causal test** — if a removed exit rule was the
   churn source, these should fall.
5. Average holding period for recently closed positions vs the prior week.
6. Did the long-only guard fire at all? Expected zero; silence is success.
7. Current holdings and heat vs the 8-position / 85% limits.
8. Any day with zero filled buys AND more than 5 guard blocks.

## Rules for the verdict

- Two sessions is a small sample. If the data is ambiguous, say so plainly rather than
  manufacturing a conclusion.
- **Never recommend disabling the overnight-hold rule.** It is a hard requirement to avoid
  pattern-day-trader penalties.
- If you recommend any change, name the specific rule and threshold and show the rows.

## Results log

**2026-08-14** (run locally after the cloud routine failed):
Buys 4/day Aug 13 and Aug 14 against an Aug 3–12 range of 2–13 — no freeze. Exits fell 41 → 5,
all `reclass_avoid`. `scan_miss` confirmed dead: 0 rows. **sell→rebuy blocks did NOT fall**
(Aug 12: 33, Aug 13: 17, Aug 14: 25) — the churn has another source, which was the headline
finding. Hold period 22.0h → 23.5h (n=4, noise). Long-only guard: 0 fires. Holdings 8/8 at
80.8% heat — capacity-constrained, not guard-frozen.
