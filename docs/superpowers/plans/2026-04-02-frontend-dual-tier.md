# Frontend Dual-Tier Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the SvelteKit dashboard to display dual-tier data (tier badges, lens scores, thesis, trade history, analytics) across all 4 pages.

**Architecture:** Purely frontend + API layer changes. The backend already writes all new data to the database. We update the TypeScript interfaces in `lib/db.ts`, add a trades API endpoint, extend the analytics API with 4 new query types, and update 4 Svelte page components to display the new data. Each page is self-contained (no shared components — matching existing patterns).

**Tech Stack:** SvelteKit 2.x, Svelte 5, Tailwind-free CSS (CSS variables dark theme), PostgreSQL via `pg`.

**Spec:** `docs/superpowers/specs/2026-04-02-frontend-dual-tier-design.md`

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `web-dashboard/src/routes/api/trades/+server.ts` | Trade history API (reads `trades` table) |

### Modified Files
| File | Changes |
|------|---------|
| `web-dashboard/src/lib/db.ts` | Add new fields to ScanResult + ScanRun interfaces |
| `web-dashboard/src/routes/+page.server.ts` | Add tier counts to stats |
| `web-dashboard/src/routes/+page.svelte` | Tier badge, lens column, expandable row, tier filter |
| `web-dashboard/src/routes/ticker/[symbol]/+page.svelte` | AI thesis hero section |
| `web-dashboard/src/routes/portfolio/+page.svelte` | AI Trades tab |
| `web-dashboard/src/routes/analytics/+page.svelte` | 4 new analytics tabs |
| `web-dashboard/src/routes/api/analytics/+server.ts` | 4 new query types |

---

## Task 1: Update TypeScript Interfaces

**Files:**
- Modify: `web-dashboard/src/lib/db.ts`

- [ ] **Step 1: Add new fields to ScanResult interface**

In `web-dashboard/src/lib/db.ts`, add these fields to the `ScanResult` interface after line 100 (before the closing brace):

```typescript
  // Dual-tier fields
  tier: string | null;
  value_score: number | null;
  catalyst_score: number | null;
  emerging_industry_score: number | null;
  thesis: string | null;
  edge_why_now: string | null;
  industry_theme: string | null;
  stop_loss_pct: number | null;
  expected_returns: any | null;
  analyst_mean_target: number | null;
  analyst_summary: string | null;
  earnings_date: string | null;
  days_to_earnings: number | null;
  earnings_beat_rate: number | null;
  news_headlines: string[] | null;
  // Trade-enriched classifier fields
  trade_rationale: string | null;
  key_risk: string | null;
```

- [ ] **Step 2: Add new fields to ScanRun interface**

Add to the `ScanRun` interface (after `duration_ms`):

```typescript
  momentum_count: number | null;
  quality_count: number | null;
```

- [ ] **Step 3: Add TradeRecord interface**

Add after the `ScanRun` interface:

```typescript
export interface TradeRecord {
  id: string;
  scan_result_id: number | null;
  run_id: string;
  ticker: string;
  action: 'BUY' | 'SELL';
  quantity: number;
  order_type: string;
  alpaca_order_id: string | null;
  status: string;
  filled_price: number | null;
  filled_at: string | null;
  classification: string | null;
  confidence: number | null;
  scores: { attention: number; momentum: number; fundamentals: number; risk: number } | null;
  trade_rationale: string | null;
  key_risk: string | null;
  position_size_pct: number | null;
  stop_loss: number | null;
  target_price: number | null;
  config_snapshot: any | null;
  created_at: string;
  updated_at: string;
  // Joined from scan_results
  company_name?: string;
  tier?: string;
  value_score?: number;
  catalyst_score?: number;
  emerging_industry_score?: number;
}
```

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener
git add web-dashboard/src/lib/db.ts
git commit -m "feat: update ScanResult, ScanRun, add TradeRecord interfaces for dual-tier"
```

---

## Task 2: Trades API Endpoint

**Files:**
- Create: `web-dashboard/src/routes/api/trades/+server.ts`

- [ ] **Step 1: Create the trades API**

Create `web-dashboard/src/routes/api/trades/+server.ts`:

```typescript
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/db';

export const GET: RequestHandler = async ({ url }) => {
  const action = url.searchParams.get('action') || null;
  const tier = url.searchParams.get('tier') || null;
  const classification = url.searchParams.get('classification') || null;
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  try {
    let whereClause = 'WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (action) {
      whereClause += ` AND t.action = $${paramIndex++}`;
      params.push(action.toUpperCase());
    }

    if (tier) {
      whereClause += ` AND sr.tier = $${paramIndex++}`;
      params.push(tier.toUpperCase());
    }

    if (classification) {
      whereClause += ` AND t.classification = $${paramIndex++}`;
      params.push(classification);
    }

    params.push(limit, offset);

    const trades = await query(
      `SELECT t.*,
        sr.company_name,
        sr.tier,
        sr.value_score,
        sr.catalyst_score,
        sr.emerging_industry_score,
        sr.price as current_price
      FROM trades t
      LEFT JOIN scan_results sr ON sr.id = t.scan_result_id
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*) as total FROM trades t
       LEFT JOIN scan_results sr ON sr.id = t.scan_result_id
       ${whereClause}`,
      params.slice(0, -2) // exclude limit/offset
    );

    return json({
      trades,
      total: parseInt((countResult[0] as any)?.total || '0'),
      limit,
      offset,
    });
  } catch (error) {
    console.error('Trades API error:', error);
    return json({ error: 'Failed to fetch trades' }, { status: 500 });
  }
};
```

- [ ] **Step 2: Verify by checking the build**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/web-dashboard
npm run build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener
git add web-dashboard/src/routes/api/trades/+server.ts
git commit -m "feat: add trades API endpoint for AI trade history"
```

---

## Task 3: Analytics API — 4 New Query Types

**Files:**
- Modify: `web-dashboard/src/routes/api/analytics/+server.ts`

- [ ] **Step 1: Add new cases to the switch statement**

In the `GET` handler's switch statement (around line 9-28), add 4 new cases before the `default`:

```typescript
      case 'tier_performance':
        return json(await getTierPerformance());
      case 'industry_themes':
        return json(await getIndustryThemes());
      case 'lens_effectiveness':
        return json(await getLensEffectiveness());
      case 'tier_over_time':
        return json(await getTierOverTime());
```

- [ ] **Step 2: Add the 4 query functions**

Append these functions at the end of the file:

```typescript
async function getTierPerformance() {
  const results = await query(`
    SELECT
      tier,
      COUNT(*) as picks,
      COUNT(CASE WHEN return_1d > 0 THEN 1 END) as wins_1d,
      ROUND(100.0 * COUNT(CASE WHEN return_1d > 0 THEN 1 END) / NULLIF(COUNT(return_1d), 0), 1) as win_rate_1d,
      ROUND(AVG(return_1d)::numeric, 2) as avg_return_1d,
      ROUND(AVG(max_gain_5d)::numeric, 2) as avg_max_gain,
      ROUND(AVG(max_drawdown_5d)::numeric, 2) as avg_max_drawdown,
      COUNT(CASE WHEN classification = 'runner' THEN 1 END) as runners,
      COUNT(CASE WHEN classification = 'value' THEN 1 END) as value_plays,
      COUNT(CASE WHEN classification = 'both' THEN 1 END) as both_plays
    FROM scan_results
    WHERE return_1d IS NOT NULL AND tier IS NOT NULL
    GROUP BY tier
  `);
  return results;
}

async function getIndustryThemes() {
  const results = await query(`
    SELECT
      industry_theme,
      COUNT(*) as picks,
      COUNT(CASE WHEN return_1d > 0 THEN 1 END) as wins,
      ROUND(100.0 * COUNT(CASE WHEN return_1d > 0 THEN 1 END) / NULLIF(COUNT(return_1d), 0), 1) as win_rate,
      ROUND(AVG(return_1d)::numeric, 2) as avg_return,
      ROUND(AVG(max_gain_5d)::numeric, 2) as avg_max_gain
    FROM scan_results
    WHERE industry_theme IS NOT NULL AND return_1d IS NOT NULL
    GROUP BY industry_theme
    ORDER BY picks DESC
  `);
  return results;
}

async function getLensEffectiveness() {
  // Value score effectiveness
  const value = await query(`
    SELECT
      CASE WHEN value_score >= 7 THEN 'High (7-10)'
           WHEN value_score >= 4 THEN 'Mid (4-6)'
           ELSE 'Low (0-3)' END as score_range,
      tier,
      COUNT(*) as picks,
      ROUND(100.0 * COUNT(CASE WHEN return_1d > 0 THEN 1 END) / NULLIF(COUNT(return_1d), 0), 1) as win_rate,
      ROUND(AVG(return_1d)::numeric, 2) as avg_return
    FROM scan_results
    WHERE value_score IS NOT NULL AND return_1d IS NOT NULL
    GROUP BY score_range, tier
    ORDER BY score_range DESC, tier
  `);

  const catalyst = await query(`
    SELECT
      CASE WHEN catalyst_score >= 7 THEN 'High (7-10)'
           WHEN catalyst_score >= 4 THEN 'Mid (4-6)'
           ELSE 'Low (0-3)' END as score_range,
      tier,
      COUNT(*) as picks,
      ROUND(100.0 * COUNT(CASE WHEN return_1d > 0 THEN 1 END) / NULLIF(COUNT(return_1d), 0), 1) as win_rate,
      ROUND(AVG(return_1d)::numeric, 2) as avg_return
    FROM scan_results
    WHERE catalyst_score IS NOT NULL AND return_1d IS NOT NULL
    GROUP BY score_range, tier
    ORDER BY score_range DESC, tier
  `);

  const emerging = await query(`
    SELECT
      CASE WHEN emerging_industry_score >= 7 THEN 'High (7-10)'
           WHEN emerging_industry_score >= 4 THEN 'Mid (4-6)'
           ELSE 'Low (0-3)' END as score_range,
      tier,
      COUNT(*) as picks,
      ROUND(100.0 * COUNT(CASE WHEN return_1d > 0 THEN 1 END) / NULLIF(COUNT(return_1d), 0), 1) as win_rate,
      ROUND(AVG(return_1d)::numeric, 2) as avg_return
    FROM scan_results
    WHERE emerging_industry_score IS NOT NULL AND return_1d IS NOT NULL
    GROUP BY score_range, tier
    ORDER BY score_range DESC, tier
  `);

  return { value, catalyst, emerging };
}

async function getTierOverTime() {
  const results = await query(`
    SELECT run_timestamp, momentum_count, quality_count, tickers_scanned
    FROM scan_runs
    WHERE status = 'completed' AND momentum_count IS NOT NULL
    ORDER BY run_timestamp DESC
    LIMIT 100
  `);
  return results;
}
```

- [ ] **Step 3: Commit**

```bash
git add web-dashboard/src/routes/api/analytics/+server.ts
git commit -m "feat: add tier, themes, lens, timeline analytics API endpoints"
```

---

## Task 4: Main Dashboard — Tier Badges, Lens Scores, Expandable Rows

**Files:**
- Modify: `web-dashboard/src/routes/+page.svelte`
- Modify: `web-dashboard/src/routes/+page.server.ts`

This is the largest UI task. The implementer should read both files completely first.

- [ ] **Step 1: Update +page.server.ts to include tier counts**

In `+page.server.ts`, add `momentumCount` and `qualityCount` to the stats object:

```typescript
  const stats = {
    totalTickers: results.length,
    runners: results.filter(r => r.classification === 'runner').length,
    valuePlays: results.filter(r => r.classification === 'value').length,
    alerts: results.filter(r => r.alert_triggered).length,
    momentumCount: latestRun?.momentum_count ?? results.filter(r => r.tier === 'MOMENTUM').length,
    qualityCount: latestRun?.quality_count ?? results.filter(r => r.tier === 'QUALITY').length,
  };
```

- [ ] **Step 2: Update +page.svelte — add state and filter**

In the script section, add:
- `let tierFilter = 'all';` to filter state
- `let expandedTicker = '';` for expandable row tracking
- Add tier filter to the `filteredResults` reactive: `if (tierFilter !== 'all' && r.tier !== tierFilter) return false;`
- Add a `toggleExpand(ticker)` function: sets `expandedTicker` to the ticker if different, or empty string if same

- [ ] **Step 3: Update stats bar**

Add two more stat cards after the existing 4:

```svelte
<div class="card stat-card">
  <div class="stat-value" style="color: var(--yellow)">{data.stats.momentumCount}</div>
  <div class="stat-label">Momentum</div>
</div>
<div class="card stat-card">
  <div class="stat-value" style="color: var(--blue)">{data.stats.qualityCount}</div>
  <div class="stat-label">Quality</div>
</div>
```

- [ ] **Step 4: Add tier filter to filter bar**

Add a new filter-group in the filters-row, after the classification filter:

```svelte
<div class="filter-group">
  <label for="tier">Tier</label>
  <select id="tier" bind:value={tierFilter}>
    <option value="all">All</option>
    <option value="MOMENTUM">Momentum</option>
    <option value="QUALITY">Quality</option>
  </select>
</div>
```

- [ ] **Step 5: Update table — add tier badge and lens column**

In the table header, add "Lens" column after "Risk". In each table row:

After the ticker name, add a tier badge:
```svelte
{#if result.tier}
  <span class="tier-badge tier-{result.tier?.toLowerCase()}">{result.tier === 'MOMENTUM' ? 'M' : 'Q'}</span>
{/if}
```

Add a Lens column cell:
```svelte
<td>
  {#if result.value_score !== null}
    <span class="lens lens-v">V:{result.value_score}</span>
    <span class="lens lens-c">C:{result.catalyst_score}</span>
    <span class="lens lens-e">E:{result.emerging_industry_score}</span>
  {:else}
    <span style="color: var(--text-muted)">-</span>
  {/if}
</td>
```

Make each row clickable to toggle expansion:
```svelte
<tr on:click={() => toggleExpand(result.ticker)} style="cursor: pointer;">
```

- [ ] **Step 6: Add expandable detail panel**

After each `</tr>`, add the expandable row:

```svelte
{#if expandedTicker === result.ticker}
  <tr class="expanded-row">
    <td colspan="10">
      <div class="expand-panel">
        {#if result.thesis}
          <div class="expand-section">
            <span class="expand-label">THESIS</span>
            <p>{result.thesis}</p>
          </div>
        {/if}
        {#if result.edge_why_now}
          <div class="expand-section">
            <span class="expand-label">WHY NOW</span>
            <p class="why-now">{result.edge_why_now}</p>
          </div>
        {/if}
        <div class="expand-metrics">
          {#if result.target_avg}
            <div class="expand-metric">
              <span class="expand-label">Target</span>
              <span class="positive">${formatNumber(result.target_avg)} ({formatPercent(((result.target_avg - result.price) / result.price) * 100)})</span>
            </div>
          {/if}
          {#if result.stop_loss_pct}
            <div class="expand-metric">
              <span class="expand-label">Stop</span>
              <span class="negative">{result.stop_loss_pct}%</span>
            </div>
          {/if}
          {#if result.expected_returns}
            <div class="expand-metric">
              <span class="expand-label">Returns</span>
              <span>1M: {result.expected_returns.oneMonth || 'N/A'} | 3M: {result.expected_returns.threeMonth || 'N/A'} | 12M: {result.expected_returns.twelveMonth || 'N/A'}</span>
            </div>
          {/if}
          {#if result.industry_theme}
            <span class="theme-badge">{result.industry_theme}</span>
          {/if}
        </div>
      </div>
    </td>
  </tr>
{/if}
```

- [ ] **Step 7: Add styles**

Add CSS for the new elements in the `<style>` section:

```css
.tier-badge {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.65rem;
  font-weight: 600;
  margin-right: 4px;
  vertical-align: middle;
}
.tier-momentum { background: var(--yellow); color: #000; }
.tier-quality { background: var(--blue); color: #fff; }

.lens { padding: 2px 6px; border-radius: 3px; font-size: 0.7rem; margin-right: 2px; }
.lens-v { background: rgba(34, 197, 94, 0.2); color: var(--green); }
.lens-c { background: rgba(59, 130, 246, 0.2); color: var(--blue); }
.lens-e { background: rgba(168, 85, 247, 0.2); color: var(--purple); }

.expanded-row td { padding: 0 !important; background: var(--bg); }
.expand-panel { padding: 1rem; border-top: 1px solid var(--border); }
.expand-section { margin-bottom: 0.75rem; }
.expand-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; display: block; margin-bottom: 0.25rem; }
.expand-section p { color: var(--text); font-size: 0.85rem; line-height: 1.5; }
.why-now { color: var(--yellow); font-style: italic; }
.expand-metrics { display: flex; gap: 12px; flex-wrap: wrap; }
.expand-metric { background: var(--bg-card); padding: 6px 10px; border-radius: 4px; font-size: 0.75rem; }
.theme-badge { background: rgba(168, 85, 247, 0.15); color: var(--purple); padding: 3px 8px; border-radius: 3px; font-size: 0.7rem; }
```

- [ ] **Step 8: Verify build**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/web-dashboard
npm run build 2>&1 | tail -5
```

- [ ] **Step 9: Commit**

```bash
git add web-dashboard/src/routes/+page.svelte web-dashboard/src/routes/+page.server.ts
git commit -m "feat: dashboard — tier badges, lens scores, expandable rows with thesis"
```

---

## Task 5: Ticker Detail — AI Thesis Hero Section

**Files:**
- Modify: `web-dashboard/src/routes/ticker/[symbol]/+page.svelte`

- [ ] **Step 1: Read the full file**

Read the entire ticker detail page to understand the layout. The file is ~1282 lines. The header section is near the top, followed by the TradingView chart embed.

- [ ] **Step 2: Add the AI Thesis Hero card**

Find the section after the header (ticker name, price, change) and before the TradingView chart. Insert a new card:

```svelte
<!-- AI Thesis Hero -->
{#if data.result.thesis}
  <div class="card thesis-hero">
    <div class="thesis-header">
      <div class="thesis-badges">
        {#if data.result.tier}
          <span class="tier-badge tier-{data.result.tier?.toLowerCase()}">{data.result.tier}</span>
        {/if}
        <span class="badge badge-{data.result.classification || 'watch'}">
          {data.result.classification || 'watch'}
        </span>
        <span style="color: var(--text-muted); font-size: 0.75rem;">
          {Math.round((data.result.confidence || 0) * 100)}% confidence
        </span>
        {#if data.result.industry_theme}
          <span class="theme-badge">{data.result.industry_theme}</span>
        {/if}
      </div>
      <div class="lens-scores">
        <div class="lens-box">
          <div class="lens-label">VALUE</div>
          <div class="lens-value" style="color: var(--green)">{data.result.value_score ?? '-'}</div>
        </div>
        <div class="lens-box">
          <div class="lens-label">CATALYST</div>
          <div class="lens-value" style="color: var(--blue)">{data.result.catalyst_score ?? '-'}</div>
        </div>
        <div class="lens-box">
          <div class="lens-label">EMERGING</div>
          <div class="lens-value" style="color: var(--purple)">{data.result.emerging_industry_score ?? '-'}</div>
        </div>
      </div>
    </div>

    <div class="thesis-body">
      <p class="thesis-text">{data.result.thesis}</p>
      {#if data.result.edge_why_now}
        <p class="thesis-why-now">{data.result.edge_why_now}</p>
      {/if}
    </div>

    <div class="thesis-footer">
      {#if data.result.target_avg}
        <div class="thesis-metric">
          <span class="thesis-metric-label">Target</span>
          <span class="positive">${Number(data.result.target_avg).toFixed(2)}
            ({(((Number(data.result.target_avg) - Number(data.result.price)) / Number(data.result.price)) * 100).toFixed(1)}%)
          </span>
        </div>
      {/if}
      {#if data.result.stop_loss_pct}
        <div class="thesis-metric">
          <span class="thesis-metric-label">Stop</span>
          <span class="negative">{data.result.stop_loss_pct}%</span>
        </div>
      {/if}
      {#if data.result.expected_returns}
        <div class="thesis-metric">
          <span class="thesis-metric-label">1M</span> {data.result.expected_returns?.oneMonth || 'N/A'}
          <span class="thesis-metric-label" style="margin-left: 8px;">3M</span> {data.result.expected_returns?.threeMonth || 'N/A'}
          <span class="thesis-metric-label" style="margin-left: 8px;">12M</span> {data.result.expected_returns?.twelveMonth || 'N/A'}
        </div>
      {/if}
      {#if data.result.position_size_pct || data.result.trade_rationale}
        <div class="thesis-metric">
          <span class="thesis-metric-label">Rationale</span>
          <span>{data.result.trade_rationale || ''}</span>
        </div>
      {/if}
    </div>
  </div>
{/if}
```

- [ ] **Step 3: Add styles**

Add to the `<style>` section:

```css
.thesis-hero { margin-bottom: 1.5rem; }
.thesis-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem; }
.thesis-badges { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lens-scores { display: flex; gap: 8px; }
.lens-box { background: var(--bg); border-radius: 6px; padding: 8px 12px; text-align: center; min-width: 60px; }
.lens-label { color: var(--text-muted); font-size: 0.6rem; text-transform: uppercase; }
.lens-value { font-weight: bold; font-size: 1.2rem; }
.thesis-body { margin-bottom: 1rem; }
.thesis-text { color: var(--text); font-size: 0.9rem; line-height: 1.5; margin-bottom: 0.5rem; }
.thesis-why-now { color: var(--yellow); font-size: 0.85rem; font-style: italic; }
.thesis-footer { display: flex; gap: 12px; flex-wrap: wrap; border-top: 1px solid var(--border); padding-top: 0.75rem; }
.thesis-metric { background: var(--bg); padding: 6px 10px; border-radius: 4px; font-size: 0.75rem; }
.thesis-metric-label { color: var(--text-muted); margin-right: 4px; }
.tier-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
.tier-momentum { background: var(--yellow); color: #000; }
.tier-quality { background: var(--blue); color: #fff; }
.theme-badge { background: rgba(168, 85, 247, 0.15); color: var(--purple); padding: 3px 8px; border-radius: 3px; font-size: 0.7rem; }
```

- [ ] **Step 4: Commit**

```bash
git add web-dashboard/src/routes/ticker/\[symbol\]/+page.svelte
git commit -m "feat: ticker detail — AI thesis hero section with lens scores"
```

---

## Task 6: Portfolio — AI Trades Tab

**Files:**
- Modify: `web-dashboard/src/routes/portfolio/+page.svelte`

- [ ] **Step 1: Read the full file**

Read the entire portfolio page (~649 lines). Understand the existing tab structure (positions, orders, trade).

- [ ] **Step 2: Add AI trades state and fetch function**

In the script section, add:

```typescript
  interface AITrade {
    id: string;
    ticker: string;
    action: 'BUY' | 'SELL';
    quantity: number;
    status: string;
    filled_price: number | null;
    classification: string | null;
    trade_rationale: string | null;
    key_risk: string | null;
    scores: any;
    stop_loss: number | null;
    target_price: number | null;
    created_at: string;
    company_name: string | null;
    tier: string | null;
    value_score: number | null;
    catalyst_score: number | null;
    emerging_industry_score: number | null;
  }

  let aiTrades: AITrade[] = [];
  let aiTradesTotal = 0;
  let aiTradeFilter = 'all'; // all, BUY, SELL
```

Add fetch function:

```typescript
  async function fetchAITrades() {
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (aiTradeFilter !== 'all') params.set('action', aiTradeFilter);
      const res = await fetch(`/api/trades?${params}`);
      if (res.ok) {
        const data = await res.json();
        aiTrades = data.trades;
        aiTradesTotal = data.total;
      }
    } catch (e) {
      console.error('Failed to fetch AI trades:', e);
    }
  }
```

Add to `onMount`: `fetchAITrades()` alongside existing fetches.

- [ ] **Step 3: Add the AI Trades tab button**

In the tabs div, add after the Trade tab button:

```svelte
<button class:active={activeTab === 'aiTrades'} on:click={() => activeTab = 'aiTrades'}>
  AI Trades ({aiTradesTotal})
</button>
```

- [ ] **Step 4: Add the AI Trades tab content**

After the Trade tab content block, add:

```svelte
{#if activeTab === 'aiTrades'}
  <div class="card">
    <div style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
      <button class="filter-btn" class:active={aiTradeFilter === 'all'} on:click={() => { aiTradeFilter = 'all'; fetchAITrades(); }}>All</button>
      <button class="filter-btn" class:active={aiTradeFilter === 'BUY'} on:click={() => { aiTradeFilter = 'BUY'; fetchAITrades(); }}>Buys</button>
      <button class="filter-btn" class:active={aiTradeFilter === 'SELL'} on:click={() => { aiTradeFilter = 'SELL'; fetchAITrades(); }}>Sells</button>
    </div>

    {#if aiTrades.length > 0}
      {#each aiTrades as trade}
        <div class="ai-trade-card">
          <div class="ai-trade-header">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="action-badge action-{trade.action.toLowerCase()}">{trade.action}</span>
              {#if trade.tier}
                <span class="tier-badge tier-{trade.tier.toLowerCase()}">{trade.tier === 'MOMENTUM' ? 'M' : 'Q'}</span>
              {/if}
              <a href="/ticker/{trade.ticker}"><strong>{trade.ticker}</strong></a>
              <span style="color: var(--text-muted);">{trade.quantity} shares {trade.filled_price ? `@ $${Number(trade.filled_price).toFixed(2)}` : ''}</span>
              {#if trade.classification}
                <span class="badge badge-{trade.classification}">{trade.classification}</span>
              {/if}
            </div>
            <span style="color: var(--text-muted); font-size: 0.75rem;">{formatDate(trade.created_at)}</span>
          </div>
          {#if trade.trade_rationale}
            <div class="ai-trade-body">
              <span style="color: var(--text); font-size: 0.8rem;">{trade.trade_rationale}</span>
              {#if trade.value_score !== null && trade.value_score !== undefined}
                <span style="color: var(--text-muted); font-size: 0.7rem; margin-left: 8px;">
                  V:{trade.value_score} C:{trade.catalyst_score} E:{trade.emerging_industry_score}
                </span>
              {/if}
              {#if trade.target_price}
                <span style="color: var(--text-muted); font-size: 0.7rem; margin-left: 8px;">
                  Target: ${Number(trade.target_price).toFixed(2)}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {:else}
      <p class="no-data">No AI trades yet. Enable trading in config to start.</p>
    {/if}
  </div>
{/if}
```

- [ ] **Step 5: Add styles**

```css
.ai-trade-card { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 0.5rem; overflow: hidden; }
.ai-trade-header { padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; background: var(--bg-card); }
.ai-trade-body { padding: 8px 12px; background: var(--bg); border-top: 1px solid var(--border); }
.action-badge { padding: 2px 8px; border-radius: 3px; font-size: 0.7rem; font-weight: 600; }
.action-buy { background: var(--green); color: #000; }
.action-sell { background: var(--red); color: #fff; }
.filter-btn { background: var(--bg); border: 1px solid var(--border); color: var(--text-muted); padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
.filter-btn.active { border-color: var(--blue); color: var(--text); }
.tier-badge { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 0.65rem; font-weight: 600; }
.tier-momentum { background: var(--yellow); color: #000; }
.tier-quality { background: var(--blue); color: #fff; }
```

- [ ] **Step 6: Commit**

```bash
git add web-dashboard/src/routes/portfolio/+page.svelte
git commit -m "feat: portfolio — AI Trades tab with rationale and lens scores"
```

---

## Task 7: Analytics — 4 New Tabs

**Files:**
- Modify: `web-dashboard/src/routes/analytics/+page.svelte`

This is the largest page (~975 lines). The implementer should read it to understand the existing tab pattern.

- [ ] **Step 1: Read the file and understand the tab pattern**

The page uses `let activeTab = 'overview'` and `{#if activeTab === 'xxx'}` blocks. Each tab fetches data on mount or on tab switch.

- [ ] **Step 2: Add state for new tabs**

In the script section, add:

```typescript
  let tierPerformance: any[] = [];
  let industryThemes: any[] = [];
  let lensEffectiveness: any = { value: [], catalyst: [], emerging: [] };
  let tierOverTime: any[] = [];
```

Add fetch functions:

```typescript
  async function fetchTierPerformance() {
    try {
      const res = await fetch('/api/analytics?type=tier_performance');
      if (res.ok) tierPerformance = await res.json();
    } catch (e) { console.error('Tier performance fetch failed:', e); }
  }

  async function fetchIndustryThemes() {
    try {
      const res = await fetch('/api/analytics?type=industry_themes');
      if (res.ok) industryThemes = await res.json();
    } catch (e) { console.error('Industry themes fetch failed:', e); }
  }

  async function fetchLensEffectiveness() {
    try {
      const res = await fetch('/api/analytics?type=lens_effectiveness');
      if (res.ok) lensEffectiveness = await res.json();
    } catch (e) { console.error('Lens effectiveness fetch failed:', e); }
  }

  async function fetchTierOverTime() {
    try {
      const res = await fetch('/api/analytics?type=tier_over_time');
      if (res.ok) tierOverTime = await res.json();
    } catch (e) { console.error('Tier over time fetch failed:', e); }
  }
```

- [ ] **Step 3: Add tab buttons**

Add 4 new tab buttons in the existing tabs div:

```svelte
<button class:active={activeTab === 'tiers'} on:click={() => { activeTab = 'tiers'; fetchTierPerformance(); }}>Tiers</button>
<button class:active={activeTab === 'themes'} on:click={() => { activeTab = 'themes'; fetchIndustryThemes(); }}>Themes</button>
<button class:active={activeTab === 'lens'} on:click={() => { activeTab = 'lens'; fetchLensEffectiveness(); }}>Lens</button>
<button class:active={activeTab === 'timeline'} on:click={() => { activeTab = 'timeline'; fetchTierOverTime(); }}>Timeline</button>
```

- [ ] **Step 4: Add Tiers tab content**

```svelte
{#if activeTab === 'tiers'}
  <div class="tier-comparison">
    {#each tierPerformance as tier}
      <div class="card tier-card" style="border-color: {tier.tier === 'MOMENTUM' ? 'var(--yellow)' : 'var(--blue)'}44;">
        <h3 style="color: {tier.tier === 'MOMENTUM' ? 'var(--yellow)' : 'var(--blue)'}; margin-bottom: 1rem;">{tier.tier}</h3>
        <div class="tier-stats">
          <div><span class="stat-label-sm">Picks</span><br><strong>{tier.picks}</strong></div>
          <div><span class="stat-label-sm">Win Rate</span><br><strong>{tier.win_rate_1d ?? '—'}%</strong></div>
          <div><span class="stat-label-sm">Avg Return</span><br><strong>{tier.avg_return_1d ?? '—'}%</strong></div>
          <div><span class="stat-label-sm">Avg Max Gain</span><br><strong>{tier.avg_max_gain ?? '—'}%</strong></div>
          <div><span class="stat-label-sm">Avg Drawdown</span><br><strong>{tier.avg_max_drawdown ?? '—'}%</strong></div>
          <div><span class="stat-label-sm">Runners</span><br><strong>{tier.runners}</strong></div>
          <div><span class="stat-label-sm">Value</span><br><strong>{tier.value_plays}</strong></div>
        </div>
      </div>
    {/each}
    {#if tierPerformance.length === 0}
      <p class="no-data">No tier data yet. Run the pipeline with the dual-tier system to populate.</p>
    {/if}
  </div>
{/if}
```

- [ ] **Step 5: Add Themes tab content**

```svelte
{#if activeTab === 'themes'}
  <div class="card">
    {#if industryThemes.length > 0}
      <table>
        <thead>
          <tr>
            <th>Industry Theme</th>
            <th>Picks</th>
            <th>Win Rate</th>
            <th>Avg Return</th>
            <th>Avg Max Gain</th>
          </tr>
        </thead>
        <tbody>
          {#each industryThemes as theme}
            <tr>
              <td><span class="theme-badge">{theme.industry_theme}</span></td>
              <td>{theme.picks}</td>
              <td class={Number(theme.win_rate) >= 50 ? 'positive' : 'negative'}>{theme.win_rate}%</td>
              <td class={Number(theme.avg_return) >= 0 ? 'positive' : 'negative'}>{theme.avg_return}%</td>
              <td>{theme.avg_max_gain}%</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="no-data">No theme data yet.</p>
    {/if}
  </div>
{/if}
```

- [ ] **Step 6: Add Lens tab content**

```svelte
{#if activeTab === 'lens'}
  <div class="lens-grid">
    {#each [
      { name: 'Value Score', data: lensEffectiveness.value, color: 'var(--green)' },
      { name: 'Catalyst Score', data: lensEffectiveness.catalyst, color: 'var(--blue)' },
      { name: 'Emerging Industry Score', data: lensEffectiveness.emerging, color: 'var(--purple)' }
    ] as lens}
      <div class="card">
        <h3 style="color: {lens.color}; margin-bottom: 1rem; font-size: 0.9rem;">{lens.name}</h3>
        {#if lens.data && lens.data.length > 0}
          <table>
            <thead>
              <tr><th>Range</th><th>Tier</th><th>Picks</th><th>Win Rate</th><th>Avg Return</th></tr>
            </thead>
            <tbody>
              {#each lens.data as row}
                <tr>
                  <td>{row.score_range}</td>
                  <td>{row.tier}</td>
                  <td>{row.picks}</td>
                  <td class={Number(row.win_rate) >= 50 ? 'positive' : 'negative'}>{row.win_rate}%</td>
                  <td class={Number(row.avg_return) >= 0 ? 'positive' : 'negative'}>{row.avg_return}%</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <p class="no-data">No data yet.</p>
        {/if}
      </div>
    {/each}
  </div>
{/if}
```

- [ ] **Step 7: Add Timeline tab content**

```svelte
{#if activeTab === 'timeline'}
  <div class="card">
    <h3 style="margin-bottom: 1rem; font-size: 0.9rem;">Tier Distribution Per Run</h3>
    {#if tierOverTime.length > 0}
      <div class="timeline-chart">
        {#each tierOverTime.slice(0, 30) as run}
          <div class="timeline-bar">
            <div class="timeline-date">{new Date(run.run_timestamp).toLocaleDateString()}</div>
            <div class="bar-container">
              {#if run.momentum_count}
                <div class="bar bar-momentum" style="width: {(run.momentum_count / (run.tickers_scanned || 1)) * 100}%;">
                  {run.momentum_count}
                </div>
              {/if}
              {#if run.quality_count}
                <div class="bar bar-quality" style="width: {(run.quality_count / (run.tickers_scanned || 1)) * 100}%;">
                  {run.quality_count}
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <p class="no-data">No timeline data yet.</p>
    {/if}
  </div>
{/if}
```

- [ ] **Step 8: Add styles for all 4 tabs**

```css
.tier-comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.tier-card h3 { font-size: 1rem; }
.tier-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; }
.stat-label-sm { font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; }
.theme-badge { background: rgba(168, 85, 247, 0.15); color: var(--purple); padding: 3px 8px; border-radius: 3px; font-size: 0.75rem; }
.lens-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
.timeline-chart { display: flex; flex-direction: column; gap: 4px; }
.timeline-bar { display: flex; align-items: center; gap: 8px; }
.timeline-date { font-size: 0.7rem; color: var(--text-muted); min-width: 80px; }
.bar-container { flex: 1; display: flex; height: 24px; border-radius: 4px; overflow: hidden; background: var(--bg); }
.bar { display: flex; align-items: center; justify-content: center; font-size: 0.65rem; font-weight: 600; min-width: 20px; }
.bar-momentum { background: var(--yellow); color: #000; }
.bar-quality { background: var(--blue); color: #fff; }
.no-data { color: var(--text-muted); font-style: italic; text-align: center; padding: 2rem; }
@media (max-width: 768px) {
  .tier-comparison { grid-template-columns: 1fr; }
  .lens-grid { grid-template-columns: 1fr; }
  .tier-stats { grid-template-columns: repeat(2, 1fr); }
}
```

- [ ] **Step 9: Commit**

```bash
git add web-dashboard/src/routes/analytics/+page.svelte
git commit -m "feat: analytics — tier performance, themes, lens effectiveness, timeline tabs"
```

---

## Task 8: Build & Deploy Verification

**Files:** No new files.

- [ ] **Step 1: Full build check**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/web-dashboard
npm run build
```

Expected: Clean build, no errors.

- [ ] **Step 2: Dev server smoke test**

```bash
npm run dev
```

Open in browser. Check:
- Main dashboard loads, tier badges visible (or blank if no data yet)
- Click a row to expand — thesis panel appears
- Ticker detail page shows hero section (or blank if no data)
- Portfolio page shows AI Trades tab (empty until trades exist)
- Analytics page has 4 new tabs (empty until data exists)

- [ ] **Step 3: Push and deploy**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener
git push origin main
```

Vercel will auto-deploy the frontend. Railway already has the backend deployed.

- [ ] **Step 4: Verify on production**

Check the Vercel deployment URL to make sure the new pages render correctly.
