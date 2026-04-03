# Frontend Updates for Dual-Tier System — Design Spec

**Date:** 2026-04-02
**Status:** Approved
**Scope:** Surface tier, lens scores, thesis, enrichment data, and trade history across all dashboard pages.

---

## Overview

Update the SvelteKit dashboard to display the new dual-tier data across 4 pages: main dashboard (hybrid table with expandable rows), ticker detail (AI thesis hero section), portfolio (AI trades tab), and analytics (4 new views). All data already exists in the database — this is purely frontend work plus a few new API endpoints.

---

## 1. Main Dashboard — Hybrid Table + Expandable Row

### Table Changes
- Add **tier badge** (colored M/Q chip) next to ticker name in the first column
- Add **"Lens" column** after the existing score columns showing V:X C:X E:X as colored chips (green/blue/purple)
- Keep all existing columns (ticker, price, change, market cap, attention, momentum, fundamentals, risk, classification)

### Expandable Row
- Click any row to toggle an inline detail panel below it
- Panel shows:
  - **Thesis** (2-3 sentences)
  - **Edge/Why Now** (1-2 sentences, italic, yellow-tinted)
  - **Target price** with upside %, **Stop-loss %**, **Expected returns** (1M/3M/12M)
  - **Industry theme** tag (purple chip, e.g., "AI infrastructure")
  - **Catalysts** list
- Only one row expanded at a time (clicking another collapses the previous)

### Filter Bar
- Add **tier filter** dropdown: All / MOMENTUM / QUALITY
- Existing filters (classification, price range, score minimums) stay unchanged

### Stats Bar
- Add **MOMENTUM count** and **QUALITY count** alongside existing runners/value/alerts stats
- Read from `scan_runs.momentum_count` and `scan_runs.quality_count` on latest run

### Data Layer
- Server load (`+page.server.ts`) already uses `SELECT *` — new columns come free
- Add `tier`, `value_score`, `catalyst_score`, `emerging_industry_score`, `thesis`, `edge_why_now`, `industry_theme`, `stop_loss_pct`, `expected_returns` to the `ScanResult` interface in `lib/db.ts`

---

## 2. Ticker Detail — AI Thesis Hero Section

### New Section: Below Header, Above Chart

A prominent card containing:

**Top row:**
- Classification badge (runner/value/both/watch/avoid) with confidence %
- Industry theme tag (purple chip)
- Tier badge

**Body:**
- **Thesis** text (2-3 sentences, primary text color, 0.9rem)
- **Edge/Why Now** (italic, yellow/amber color)

**Right side (inline with body):**
- Three lens score boxes: Value (green), Catalyst (blue), Emerging Industry (purple) — each showing 0-10

**Bottom row (separated by border):**
- Target price with upside %
- Stop-loss %
- Expected returns: 1M / 3M / 12M
- Suggested position size %

### Existing Sections
All existing sections stay in place below the hero: TradingView chart, score cards, technicals, price targets, market data, analysis (bull/bear case — now populated with richer content), catalysts, news, insider transactions.

### Data Layer
- Server load (`+page.server.ts`) already uses `SELECT *` — new columns come free
- No new API calls needed

---

## 3. Portfolio — New "AI Trades" Tab

### Tab Structure
Add a 4th tab: **Positions** | **Orders** | **Trade** | **AI Trades (N)**

### AI Trades Tab Content
- Reads from `trades` table via new `GET /api/trades` endpoint
- Each trade displayed as a card/row:
  - **Header**: BUY/SELL badge (green/red), tier badge (M/Q), ticker (bold), quantity + price, classification badge, P&L % if filled
  - **Body** (below header): trade rationale text, lens scores (V/C/E), target, stop-loss
- Most recent trades first
- Pagination: 50 per page

### Filters
- Action: All / BUY / SELL
- Tier: All / MOMENTUM / QUALITY
- Classification: All / runner / value / both

### New API Endpoint: `GET /api/trades`

```
GET /api/trades?action=BUY&tier=QUALITY&classification=value&limit=50&offset=0
```

Query:
```sql
SELECT t.*, sr.company_name, sr.price as current_price
FROM trades t
LEFT JOIN scan_results sr ON sr.id = t.scan_result_id
ORDER BY t.created_at DESC
LIMIT $limit OFFSET $offset
```

Returns: array of trade objects with rationale, scores, classification, tier info.

---

## 4. Analytics — 4 New Views

Add 4 new tabs to the existing analytics page (alongside Overview, Win Rates, Sectors, Technical Signals, Target Accuracy, Backtest).

### Tab A: Tier Performance

Side-by-side MOMENTUM vs QUALITY comparison cards:
- Total picks
- Win rate (1d, 5d)
- Avg return (1d, 5d)
- Avg max gain
- Avg max drawdown

Query:
```sql
SELECT tier,
  COUNT(*) as picks,
  ROUND(100.0 * COUNT(CASE WHEN return_1d > 0 THEN 1 END) / NULLIF(COUNT(return_1d), 0), 1) as win_rate_1d,
  ROUND(AVG(return_1d)::numeric, 2) as avg_return_1d,
  ROUND(AVG(max_gain_5d)::numeric, 2) as avg_max_gain,
  ROUND(AVG(max_drawdown_5d)::numeric, 2) as avg_max_drawdown
FROM scan_results
WHERE return_1d IS NOT NULL AND tier IS NOT NULL
GROUP BY tier
```

### Tab B: Industry Themes

Table with sortable columns:
- Industry theme name
- Pick count
- Win rate
- Avg return
- Top classification breakdown

Query:
```sql
SELECT industry_theme, COUNT(*) as picks,
  ROUND(100.0 * COUNT(CASE WHEN return_1d > 0 THEN 1 END) / NULLIF(COUNT(return_1d), 0), 1) as win_rate,
  ROUND(AVG(return_1d)::numeric, 2) as avg_return
FROM scan_results
WHERE industry_theme IS NOT NULL AND return_1d IS NOT NULL
GROUP BY industry_theme
ORDER BY picks DESC
```

### Tab C: Lens Effectiveness

Table showing win rate by lens score ranges, per tier:
- Rows: score ranges (0-3, 4-6, 7-10)
- Columns: value_score, catalyst_score, emerging_industry_score
- Values: win rate and pick count

Query per lens:
```sql
SELECT
  CASE WHEN value_score >= 7 THEN 'High (7-10)'
       WHEN value_score >= 4 THEN 'Mid (4-6)'
       ELSE 'Low (0-3)' END as range,
  tier,
  COUNT(*) as picks,
  ROUND(100.0 * COUNT(CASE WHEN return_1d > 0 THEN 1 END) / NULLIF(COUNT(return_1d), 0), 1) as win_rate
FROM scan_results
WHERE value_score IS NOT NULL AND return_1d IS NOT NULL
GROUP BY range, tier
ORDER BY range DESC
```

### Tab D: Tier Over Time

Bar or line chart showing MOMENTUM and QUALITY counts per pipeline run over the last 30 days.

Query:
```sql
SELECT run_timestamp, momentum_count, quality_count
FROM scan_runs
WHERE status = 'completed' AND momentum_count IS NOT NULL
ORDER BY run_timestamp DESC
LIMIT 100
```

Rendered as a simple stacked bar chart or two overlapping lines. Can use CSS bars (similar to existing analytics approach) or a simple inline SVG.

### API Updates

Add new query types to existing `GET /api/analytics`:
- `?type=tier_performance` — Tab A
- `?type=industry_themes` — Tab B
- `?type=lens_effectiveness` — Tab C
- `?type=tier_over_time` — Tab D

---

## 5. Shared Data Layer Changes

### Update `ScanResult` in `lib/db.ts`

Add to the existing interface:
```typescript
tier: string | null;
value_score: number | null;
catalyst_score: number | null;
emerging_industry_score: number | null;
thesis: string | null;
edge_why_now: string | null;
industry_theme: string | null;
stop_loss_pct: number | null;
expected_returns: { oneMonth: string; threeMonth: string; twelveMonth: string } | null;
analyst_mean_target: number | null;
analyst_summary: string | null;
earnings_date: string | null;
days_to_earnings: number | null;
earnings_beat_rate: number | null;
news_headlines: string[] | null;
```

### Update `ScanRun` in `lib/db.ts`

Add:
```typescript
momentum_count: number | null;
quality_count: number | null;
```

---

## 6. Files Changed

### New Files
| File | Responsibility |
|------|---------------|
| `web-dashboard/src/routes/api/trades/+server.ts` | Trade history API endpoint |

### Modified Files
| File | Changes |
|------|---------|
| `web-dashboard/src/lib/db.ts` | Update ScanResult + ScanRun interfaces |
| `web-dashboard/src/routes/+page.svelte` | Tier badge, lens column, expandable row, tier filter, stats |
| `web-dashboard/src/routes/+page.server.ts` | Include momentum_count/quality_count from scan_runs |
| `web-dashboard/src/routes/ticker/[symbol]/+page.svelte` | AI thesis hero section |
| `web-dashboard/src/routes/portfolio/+page.svelte` | AI Trades tab |
| `web-dashboard/src/routes/analytics/+page.svelte` | 4 new tabs (tier perf, themes, lens, tier over time) |
| `web-dashboard/src/routes/api/analytics/+server.ts` | 4 new query types |

---

## Out of Scope

- Reusable component extraction (each page stays self-contained, matching existing pattern)
- Real-time websocket updates
- Mobile-first redesign (existing responsive approach stays)
- TradingView chart changes
- Sector heatmap updates
- Alert management changes
