# Research Screens — Company Analysis & Entry Analysis

**Date:** 2026-06-16
**Status:** Design approved, pending spec review
**Source request:** `Finance Screens for Samir_061026 (1).docx` (two screens defined by the user)

---

## 1. Summary

Add a new **Research** section to the dashboard with two on-demand, single-ticker tools, distinct from the existing automated sentiment/catalyst screener and its auto-trading loop:

- **Screen 1 — Company Analysis:** deep fundamental analysis of one ticker, rendered as five interactive tabs (web view only), including a 0–100 investment grade per a defined rubric.
- **Screen 2 — Entry Analysis:** given a ticker and a desired $ position, produce a staged limit-order entry plan (≤6 tranches) and stage those orders natively on the existing Alpaca paper account.

These are discretionary research tools for the user, not part of the hands-off bot. They reuse the app's existing data infrastructure.

### Decisions locked during brainstorming

| Question | Decision |
|---|---|
| Form factor | Feature inside the existing app (dashboard pages + server routes) |
| Data engine | Perplexity (`sonar`) primary for estimates / earnings-call synthesis / qualitative; free APIs (Alpha Vantage statements, Yahoo quote, Finnhub) for hard numbers |
| Screen 1 output | Web view only (no Excel export in v1; may add later) |
| Screen 2 actionability | Actionable — stages orders on Alpaca |
| Alpaca account | Same paper account as the bot, orders tagged `s2-<ticker>-<n>` |
| Order type | GTC limit buys, placed immediately (native, resting on the book) |
| Price triggers | Native resting limits — no price-watching cron; every tranche expressed as a limit price |
| Build order | Approach A — Screen 1 end-to-end first, then Screen 2 |

---

## 2. Architecture

The dashboard's SvelteKit server routes already fetch data directly (e.g. `/api/alpaca` hits the Alpaca paper API with env keys; `/api/ticker/[symbol]` calls Finnhub/Yahoo/Finviz directly; all read/write the shared Postgres via `lib/db.ts`). The Railway backend is cron-only with **no HTTP server**. The research screens follow the established direct-fetch pattern — **no Railway backend changes required**.

```
/research/company  (page)  ── fetch ──▶  /api/research/company/[symbol]?section=…
                                              │  Perplexity (sonar) + Alpha Vantage + Yahoo
                                              │  cache read/write → company_analysis (JSONB)
                                              ▼
                                          structured section JSON → tab renders

/research/entry    (page)  ── POST ──▶  /api/research/entry           → entry_plans (draft)
                           ── POST ──▶  /api/research/entry/execute   → Alpaca GTC limits
                                                                       → entry_orders rows
```

### Why section-by-section for Screen 1

Each section is fetched independently (`?section=financials|metrics|comps|oppsrisks|grade`), mirroring the existing `/api/ticker/[symbol]?type=` pattern. Benefits:

- No single request runs long → avoids Vercel function-duration limits a monolithic Perplexity "deep research" call would risk.
- Tabs stream in as they resolve; a failed section shows a per-tab error without breaking the page.
- Caching is per-section.

### Caching

Each section result is persisted to `company_analysis` keyed by `(ticker, section, analysis_date)`. Same-day requests read from cache. A per-tab/per-page **Refresh** button forces a re-run (upsert), the only path that re-spends Perplexity tokens.

---

## 3. Screen 1 — Company Analysis

Route: `/research/company`. Input: ticker. Five tabs, each its own cached section.

### Tab 1 — Financials
- **Rows:** revenue, gross profit, EBITDA, operating income, net income, EPS, key margins (gross/operating/net).
- **Columns:** up to 5 historical annual years (Alpha Vantage `INCOME_STATEMENT`/`BALANCE_SHEET`/`CASH_FLOW`), plus ≥1 forward estimate year (Perplexity consensus/guidance), then two appended columns:
  - **CAGR** (computed over the available historical span)
  - **Driver commentary** (Perplexity, one line per row explaining the trend's drivers)
- **Header note:** short grade of how well management's aggressive targets (if any) are supported by historical trend + market size ("believability of management vs stated plans").

### Tab 2 — Metrics
- Enterprise Value, Debt/Equity, Interest Coverage, balance-sheet cash, AR turnover, Inventory turnover, P/E, EV/Revenue, EV/EBITDA.
- Computed from statements where possible; Perplexity-filled where the free data can't supply it.
- Each metric shows: **company value** + **industry-average** + **industry-leader** benchmark (Perplexity-sourced — no structured comps feed available).

### Tab 3 — Public Comps
- Peer table: ticker vs industry peers on EV/Revenue, gross margin, EBITDA margin, net/NIM margin.
- Peer set chosen by Perplexity (same sector/size); values from Alpha Vantage/Yahoo where available, else Perplexity.

### Tab 4 — Opportunities & Risks
- Two columns (opportunities | risks), each a vertical list.
- Perplexity synthesizes the **last 18 months** of earnings reports/calls into opportunities and risks of management's plans.

### Tab 5 — Investment Grade
- Single **0–100** score using the docx rubric bands verbatim:
  - **0–20** Highly speculative — poor/neutral fundamentals, no price momentum, risk/reward unfavorable
  - **21–40** Speculative — price *or* fundamentals improving, not both; uncertain phase
  - **41–60** Neutral — sound price + fundamentals + balance sheet, but no clear growth story
  - **61–80** Clear opportunity — growing business, price + industry momentum; younger names need realized metrics/cash flow
  - **81–100** Buy at any price — profits/growth outpacing price; accumulating even at ATH is risk/reward positive
- Perplexity assigns the score given all prior sections as context, constrained to the rubric, with a justifying paragraph.

### Separation from the auto-trader
This 0–100 grade is **independent** of the bot's composite/conviction scores. It is a discretionary research grade per the docx rubric and is **not** wired into trading. The UI labels it clearly to avoid conflation.

---

## 4. Screen 2 — Entry Analysis

Route: `/research/entry`. Inputs: **ticker** + **desired $ position** (default $4,000, editable).

### Analysis inputs (docx parameters)
- **Time-series averages** — current price vs 8/20/50-day and 52-week MAs (computed from Alpha Vantage/Yahoo daily series); locates price vs support.
- **Volume trends** — recent volume vs historical average (computed rel-volume + Perplexity narrative); flags the "hot stock fading on declining volume" case.
- **Short interest** — % of float short and trend (Perplexity-sourced).
- **Holders & drivers** — biggest holders (institutional/insider/retail) and drivers of recent moves: buybacks, insider buying, institutional flows (Perplexity).

### Plan generation (deterministic, in the route — not LLM)
Share math is computed in code so it is exact:
- Split desired $ into **≤6 tranches**, volatility-scaled: more volatile → smaller initial tranche, entries staged lower toward VWAP/support; stable → fewer/larger entries.
- **Don't chase:** every tranche limit price sits at or below recent support; never above current price.
- Every tranche is expressed as a **limit price** (even time-oriented ones), so all orders can rest natively.
- Each tranche row: **shares, limit price, trigger rationale (price level and/or expected timing), rationale text**.

### Execution (confirm-gated)
1. Plan renders read-only first; saved to `entry_plans` as `draft`.
2. **"Stage these orders"** → confirmation summary (total shares, total $, account = paper).
3. On confirm, `POST /api/research/entry/execute` places each tranche as a **GTC limit buy** on the Alpaca paper account, tagged `client_order_id = s2-<ticker>-<n>`. Plan status → `staged`; one `entry_orders` row per tranche.
4. Page reconciles live Alpaca status (open/filled/cancelled) and offers **"Cancel remaining."**

### Alpaca client changes
The existing `placeOrder` (`backend/src/services/alpaca.ts`) only supports `time_in_force: 'day'` and no client tag. Screen 2 places orders **directly from the dashboard server route** (matching the `/api/alpaca` pattern), so the dashboard's order body adds `time_in_force: 'gtc'` and `client_order_id`. If the backend `placeOrder` is also touched, extend `PlaceOrderParams` with optional `timeInForce` and `clientOrderId` for parity — but no backend deploy is required for this feature.

### Bot-interference note
These orders land in the bot's paper account, so the auto-trader counts them in its position/heat checks. The `s2-` tag is recorded so the bot *can* later be taught to exclude them; for v1 they share the account and the UI surfaces a heads-up. No bot changes in this spec.

---

## 5. Data model

New migration `database/migration-013-research.sql`:

### `company_analysis`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| ticker | text | |
| section | text | `financials\|metrics\|comps\|oppsrisks\|grade` |
| analysis_date | date | |
| payload | jsonb | structured section result |
| created_at | timestamptz | default now() |

Unique `(ticker, section, analysis_date)` → same-day cache read; Refresh upserts.

### `entry_plans`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| ticker | text | |
| desired_position_usd | numeric | |
| plan | jsonb | tranches + MA/volume/short/holder analysis |
| status | text | `draft\|staged\|cancelled` |
| created_at | timestamptz | default now() |

### `entry_orders`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| entry_plan_id | int FK → entry_plans | |
| tranche_n | int | |
| client_order_id | text | `s2-<ticker>-<n>`, unique |
| alpaca_order_id | text | nullable until placed |
| shares | numeric | |
| limit_price | numeric | |
| status | text | open/filled/cancelled/etc. |
| created_at | timestamptz | default now() |

---

## 6. Error handling, cost, testing

### Error handling
- Every external call (Perplexity, Alpha Vantage, Yahoo, Alpaca) wrapped in try/catch.
- A failed Screen 1 section returns a per-tab error state; other tabs unaffected (sections independent).
- Alpha Vantage free-tier rate limit (~5/min) handled with the existing retry/delay approach. If AV statements are unavailable for a ticker, the tab degrades to Perplexity-sourced numbers flagged `source: estimated`.

### Cost control
- Day-keyed caching → one Perplexity pass per ticker/section/day; **Refresh** is the only re-spend path.
- Perplexity token usage logged like the rest of the app.

### Execution safety
- Order staging is confirm-gated.
- Validates total $ ≤ desired position before placing.
- Rejects if Alpaca isn't configured.
- Idempotent on `client_order_id` — a double-click cannot double-place.

### Testing
- **Unit (deterministic pieces):** CAGR math; metric calculations from statements (EV, D/E, interest coverage, turnovers, EV/Rev, EV/EBITDA); tranche-sizing/limit-price logic (volatility scaling, ≤6 tranches, never above current price, sum ≤ desired position).
- **Parsing:** mocked Perplexity-response tests asserting we parse the structured JSON for each section.
- **Manual E2E:** run both screens against a couple of real tickers before calling it done; stage and cancel a real (paper) entry plan.

---

## 7. New / touched files (anticipated)

**Dashboard (Vercel / SvelteKit):**
- `web-dashboard/src/routes/research/+layout.svelte` (or nav link) — Research section
- `web-dashboard/src/routes/research/company/+page.svelte`
- `web-dashboard/src/routes/research/entry/+page.svelte`
- `web-dashboard/src/routes/api/research/company/[symbol]/+server.ts`
- `web-dashboard/src/routes/api/research/entry/+server.ts`
- `web-dashboard/src/routes/api/research/entry/execute/+server.ts`
- `web-dashboard/src/lib/research/` — Perplexity client + prompts, AV statement fetchers, metric math, tranche logic (shared by the routes)

**Database:**
- `database/migration-013-research.sql`

**Backend (optional parity only, not required to deploy):**
- `backend/src/services/alphavantage.ts` — add statement fetchers if shared
- `backend/src/services/alpaca.ts` — optional `timeInForce`/`clientOrderId` on `PlaceOrderParams`

---

## 8. Out of scope (v1)

- Excel export for Screen 1 (web view only; revisit later).
- Teaching the auto-trader to exclude `s2-` tagged positions from its risk math.
- A separate/live Alpaca account for Screen 2.
- Background price-watching cron (not needed — native GTC limits).
- Structured paid data feeds (FactSet/Daloopa/FMP/etc.).
