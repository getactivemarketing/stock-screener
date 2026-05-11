# Classifier Augmentation: Sector Pass + Veto Layer

**Status**: Design — pending implementation plan
**Date**: 2026-05-11
**Author**: Samir + Claude
**Related**: `2026-04-08-unified-screener-design.md` (current classifier baseline)

## Motivation

The unified value+catalyst classifier (`pipeline-unified.ts` + Perplexity Sonar) is producing a combined false-positive and false-negative problem: BUYs that lose money, and near-misses (composite 42-44) on names that subsequently run. Period P&L since unified launch (Apr 10) has trended negative.

The bet here is that signal quality, not data quantity, is the bottleneck. We test that by introducing two narrow Claude API integrations:

1. **Sector pass** — top-down candidate sourcing from sector momentum, free-data only
2. **Veto layer** — bottom-up quality gate on BUY decisions before order placement

Both are additive, behind feature flags, and reversible.

## Non-Goals

- Replacing Perplexity Sonar wholesale
- Confidence-weighted position sizing (deferred to a future iteration)
- Multi-step IC-memo deep dives
- Dashboard UI changes (analysis via psql for v1)
- Integration of `earnings-reviewer` or `market-researcher` agents as runtime components (skills' methodology is borrowed; agents themselves require paid feeds we don't have)

## Architecture

Two additive components plug into the existing pipeline at distinct points:

```
                  ┌──────────────────────────────────────┐
                  │  NEW: Sector Pass (daily, 13:00 UTC) │
                  │  Yahoo ETFs + Finviz + Google News   │
                  │       → Claude Sonnet 4.6            │
                  │       → sector_candidates table      │
                  └────────────────┬─────────────────────┘
                                   │ feeds into ↓
   ┌───────────────────────────────▼─────────────────────────────────┐
   │ EXISTING: 30-min cron (pipeline-unified.ts)                     │
   │   sources → merge → selectTopCandidates (w/ sector quota now)   │
   │                                  │                              │
   │   enrich → score → classifyUnified (Perplexity, unchanged)      │
   │                                  │                              │
   │   IF BUY: ┌─────────────────────▼─────────────────────────┐    │
   │           │  NEW: Veto Layer (Claude Haiku 4.5)            │    │
   │           │  confirm / veto / downgrade_to_watch           │    │
   │           └─────────────────────┬─────────────────────────┘    │
   │                                  │                              │
   │   risk check → Alpaca order (only if veto.verdict == confirm)   │
   └─────────────────────────────────────────────────────────────────┘
```

Both components run on the existing Railway backend service and call the Anthropic API directly via the SDK. No Claude Code runtime dependency.

## Component 1: Sector Pass

### Cadence

New Railway cron `0 13 * * 1-5` (8am ET, premarket). Runs before the first 14:00 UTC pipeline cron so its output is available for the day.

### Data sources (all free, no auth)

1. **Yahoo sector ETF performance** — 11 SPDRs: XLK, XLF, XLE, XLV, XLY, XLP, XLI, XLU, XLB, XLRE, XLC. Pull 1d / 5d / 1mo / 3mo change and volume vs 20d average via existing `yahoo.ts` patterns. Tells us which sectors have momentum.
2. **Finviz sectors page** — `groups.ashx?g=sector&v=110`, weekly and monthly sector performance plus breadth (% of constituents above SMA50). Confirms ETF signal.
3. **Google News RSS** — for the top 3 momentum sectors, last 24h headlines. Provides the "why now" narrative context.

If any source fails, run with what we have. If all three fail, write zero candidates and exit cleanly.

### Claude call

- Model: `claude-sonnet-4-6`
- One call per run, with prompt caching on the system prompt
- System prompt: synthesized from `equity-research/sector-overview` and `equity-research/idea-generation` skills. Emphasizes sector breadth, relative strength vs SPY, secular themes, and avoiding single-factor traps.
- User prompt: structured data block (ETF table + Finviz table + news bullets) + ask for 5-8 candidates
- Output schema:

```json
{
  "top_sectors": [
    {"sector": "Technology", "rationale": "..."}
  ],
  "candidates": [
    {
      "ticker": "AAPL",
      "sector": "Technology",
      "suggested_tier": "quality",
      "rationale": "...",
      "why_now": "..."
    }
  ]
}
```

Failures (network error, invalid JSON) → log, write zero candidates, pipeline still gets full Finviz/ApeWisdom flow.

### Pipeline integration

In `pipeline-unified.ts` `mergeBySource` step, add a new synthetic source `sector-research`. Query: `SELECT ... FROM sector_candidates WHERE run_date = CURRENT_DATE AND used_in_run_id IS NULL`. Mark rows as used (update `used_in_run_id`) on first pickup of the day so they're consumed exactly once per day.

In `selectTopCandidates`, reserve **4 slots** for the `sector-research` source. Extends the per-source quota system from commit `6dd41e5`. From the merge point onward, sector candidates flow through enrichment → scoring → classifier → veto exactly like any other candidate. No downstream special-casing.

### New files

- `backend/src/sector-research.ts` — entry point, analog to `pipeline-unified.ts`
- `backend/src/services/sector-data.ts` — ETF + Finviz sectors + Google News fetchers
- `backend/src/services/claude.ts` — Anthropic SDK wrapper (shared with veto layer)
- `backend/src/services/sector-prompts.ts` — system prompt + user prompt builder
- `railway.sector.toml` — cron service config

## Component 2: Veto Layer

### Trigger point

In `trader-unified.ts`, after `classifyUnified()` returns a BUY decision and before risk validation. Insert the veto gate between Perplexity's BUY and the Alpaca order call.

### Model

`claude-haiku-4-5-20251001`. Fires only on candidates Perplexity already classified BUY; recent volumes are ~2-5 BUYs per cron run.

### Inputs

1. Perplexity classifier output — V/C/E lens scores, composite, risk, conviction, thesis, edge_why_now, expected_returns, stop_loss_pct
2. Ticker basics — price, market cap, sector, tier (momentum/quality/speculative)
3. Sentiment summary — mention count, source breakdown, 1d/5d price change
4. Enrichment — analyst target distance (Yahoo, when available), days_to_earnings (Finnhub), 3-5 recent news headlines

### Claude call

- System prompt synthesized from `equity-research/thesis-tracker` (pre-mortem framing: "what would have to be true for this to lose money?") and `financial-analysis/comps-analysis` (peer sanity check for QUALITY-tier names)
- User prompt: structured input block
- Output schema:

```json
{
  "verdict": "confirm" | "veto" | "downgrade_to_watch",
  "confidence": 0-100,
  "reasoning": "1 paragraph",
  "key_risk": "1 sentence",
  "thesis_contradictions": []
}
```

### Decision logic

| Verdict | Action when `veto_layer_enforce=TRUE` |
|---|---|
| `confirm` | Proceed to risk validation + Alpaca order |
| `veto` | Skip trade; row still written to `trade_decisions` with all `veto_*` columns populated and no Alpaca order |
| `downgrade_to_watch` | Skip trade; same as veto, distinguishable by the `veto_verdict` value |

The existing `decision_type` column on `trade_decisions` (BUY/HOLD/SELL from Perplexity) is unchanged — the veto verdict lives in its own columns so we can always reconstruct what each layer decided.

**Fail-open default**: Claude error or invalid JSON → log the failure, proceed with the BUY. A Claude outage must not halt all trading.

### Shadow mode

The veto code path always runs and writes its verdict to `trade_decisions` when `veto_layer_enabled=TRUE`, but only *enforces* the verdict (blocks the order) when `veto_layer_enforce=TRUE`. This lets us run the veto for 5 trading days in shadow mode, compare what it would have decided against actual trade outcomes, and only then enable enforcement.

### New files

- `backend/src/services/veto.ts` — the gate function
- `backend/src/services/veto-prompts.ts` — system prompt + user prompt builder
- `backend/src/services/claude.ts` — same shared wrapper as sector pass

## Schema Changes

Single migration `database/migration-012-sector-and-veto.sql`:

```sql
CREATE TABLE sector_candidates (
  id SERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  ticker TEXT NOT NULL,
  sector TEXT,
  rationale TEXT,
  why_now TEXT,
  suggested_tier TEXT,
  used_in_run_id INT REFERENCES scan_runs(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (run_date, ticker)
);
CREATE INDEX idx_sector_candidates_unused ON sector_candidates(run_date)
  WHERE used_in_run_id IS NULL;

ALTER TABLE trade_decisions
  ADD COLUMN veto_verdict TEXT,
  ADD COLUMN veto_confidence INT,
  ADD COLUMN veto_reasoning TEXT,
  ADD COLUMN veto_key_risk TEXT,
  ADD COLUMN veto_contradictions JSONB,
  ADD COLUMN veto_model TEXT,
  ADD COLUMN veto_latency_ms INT;

ALTER TABLE trading_config
  ADD COLUMN sector_research_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN veto_layer_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN veto_layer_enforce BOOLEAN DEFAULT FALSE;
```

## Config

### Feature flags (`trading_config` table)

- `sector_research_enabled` — default TRUE. Sector cron writes candidates; pipeline reads them.
- `veto_layer_enabled` — default FALSE. When TRUE, veto runs on every BUY and logs its verdict.
- `veto_layer_enforce` — default FALSE. When TRUE *and* `veto_layer_enabled` is also TRUE, vetoes actually block orders.

### Rollout sequence

1. Day 0: deploy with all three flags at defaults (sector on, veto off)
2. Day 1: verify sector cron is writing candidates; verify pipeline picks them up
3. Day 2: flip `veto_layer_enabled=TRUE`, keep enforce off → shadow mode
4. Day 7-8: review 5 trading days of shadow-mode veto verdicts in DB. If veto cohort meets the win condition above, flip `veto_layer_enforce=TRUE`.

### Kill switches

- Disable everything new: `UPDATE trading_config SET sector_research_enabled=FALSE, veto_layer_enabled=FALSE`
- Existing master kill switch `UPDATE trading_config SET enabled=FALSE` still halts all trading

### Environment variables (Railway backend)

- New: `ANTHROPIC_API_KEY`
- Existing keys unchanged

## Measurement Plan

### Veto layer effectiveness (after 5-10 trading days)

```sql
SELECT
  veto_verdict,
  COUNT(*) AS count,
  AVG(CASE WHEN ex_post_return_pct > 0 THEN 1 ELSE 0 END) AS win_rate,
  AVG(ex_post_return_pct) AS avg_return
FROM trade_decisions
JOIN scan_results USING (ticker, run_id)
WHERE veto_verdict IS NOT NULL
GROUP BY veto_verdict;
```

Win condition for enabling enforcement: `veto` cohort has at least a 15-percentage-point lower win rate than `confirm` cohort, AND a negative average 5d return. If the veto cohort wins as often, the veto is killing winners — keep enforcement off and revisit the prompt.

### Sector pass effectiveness

```sql
SELECT
  CASE WHEN source LIKE '%sector-research%' THEN 'sector' ELSE 'bottom-up' END AS origin,
  COUNT(*) AS candidates,
  SUM(CASE WHEN classification='BUY' THEN 1 ELSE 0 END) AS buys,
  AVG(return_5d_pct) AS avg_5d_return
FROM scan_results
WHERE created_at >= NOW() - INTERVAL '14 days'
GROUP BY origin;
```

Win condition: sector-research candidates have BUY conversion rate ≥ bottom-up *and* positive 5d returns. If sector candidates are noise, drop the source quota to zero.

### Cost tracking

Lightweight token/latency logging in `claude.ts`. Predicted ~$5/month all-in. Alert if daily cost > $5.

## Known Risks

1. **Veto over-fires on small samples** — shadow mode for 3-5 days before enforcement is the mitigation.
2. **Sector candidates dilute the pool** — quota is 4 of ~40 slots, easy to revert.
3. **Cost overrun** — daily cost log in `claude.ts`; alert threshold at $5/day.
4. **Prompt cache misses** — lock prompts in v1, no edits for 2 weeks after launch.

## Out of Scope

- Confidence-weighted position sizing
- Multi-step IC-memo deep dives
- Replacing Perplexity entirely
- Dashboard UI for sector candidates or veto decisions
- Backfilling historical sector candidates
- Reprocessing past trades through the veto for retrospective scoring
- More sentiment sources (Twitter, Discord)
- Auto-tuning veto thresholds
- Multi-model agreement (Haiku + Sonnet voting)
- Earnings-reviewer agent integration
