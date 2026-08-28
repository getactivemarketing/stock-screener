# Classifier Augmentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two additive Claude API integrations (sector pass + veto layer) behind feature flags to improve stock screener signal quality without replacing Perplexity.

**Architecture:** Daily Railway cron runs a Claude Sonnet sector pass on free data (Yahoo ETFs + Finviz sectors + Google News), writes 5-8 candidates per day to `sector_candidates`. The existing 30-min pipeline picks these up as a new source with a reserved quota. After Perplexity returns a BUY, a Claude Haiku veto call confirms / vetoes / downgrades. Three flags in `trading_config` control rollout: `sector_research_enabled` (default ON), `veto_layer_enabled` (default OFF), `veto_layer_enforce` (default OFF). Shadow mode runs the veto without blocking trades; after 5 trading days of comparing veto verdicts against actual outcomes, enforcement is enabled.

**Tech Stack:** Node 22 + TypeScript 5.7, `@anthropic-ai/sdk` v0.39 (already installed), `pg`, `tsx`, PostgreSQL on Railway, Railway cron services. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-11-classifier-augmentation-design.md`

**Testing approach:** The backend has no test framework. Each task ends with a smoke-test command that runs against staging data and prints output the engineer verifies by eye. Do NOT add a test framework as part of this plan.

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `database/migration-012-sector-and-veto.sql` | Schema: sector_candidates table, veto_* columns on trade_decisions, 3 flags on trading_config |
| `backend/src/services/claude.ts` | Anthropic SDK wrapper, prompt-cached system prompts, token/latency/cost logging |
| `backend/src/services/sector-data.ts` | Fetchers: Yahoo sector ETF perf, Finviz sectors page, Google News RSS |
| `backend/src/services/sector-prompts.ts` | Sector pass system + user prompt builders, response parser |
| `backend/src/sector-research.ts` | Sector pass entry point (analog to pipeline-unified.ts) |
| `backend/src/services/veto-prompts.ts` | Veto system + user prompt builders, response parser |
| `backend/src/services/veto.ts` | Veto gate function — orchestrates Claude call + DB write |
| `backend/railway.sector.toml` | New Railway cron service config |

### Modified Files

| File | Changes |
|------|---------|
| `backend/src/lib/config.ts` | Add `anthropicApiKey` env var |
| `backend/src/types/index.ts` | Add `SectorCandidate`, `VetoVerdict`, `VetoResult` types |
| `backend/src/pipeline-unified.ts` | New `sector-research` source in mergeBySource + quota slot in selectTopCandidates |
| `backend/src/services/trader-unified.ts` | Insert veto gate after BUY classification, before risk validation; persist veto columns to trade_decisions |
| `backend/package.json` | Add `npm run sector-research` script |

---

## Task 1: Database migration

**Files:**
- Create: `database/migration-012-sector-and-veto.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- database/migration-012-sector-and-veto.sql
-- Adds sector_candidates table for daily top-down sourcing,
-- veto_* columns on trade_decisions for the veto layer,
-- and three feature flags on trading_config.

BEGIN;

CREATE TABLE IF NOT EXISTS sector_candidates (
  id SERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  ticker VARCHAR(10) NOT NULL,
  sector TEXT,
  rationale TEXT,
  why_now TEXT,
  suggested_tier TEXT CHECK (suggested_tier IN ('momentum', 'quality', 'speculative')),
  used_in_run_id UUID REFERENCES scan_runs(run_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (run_date, ticker)
);

CREATE INDEX IF NOT EXISTS idx_sector_candidates_unused
  ON sector_candidates(run_date)
  WHERE used_in_run_id IS NULL;

ALTER TABLE trade_decisions
  ADD COLUMN IF NOT EXISTS veto_verdict TEXT
    CHECK (veto_verdict IN ('confirm', 'veto', 'downgrade_to_watch')),
  ADD COLUMN IF NOT EXISTS veto_confidence INT
    CHECK (veto_confidence BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS veto_reasoning TEXT,
  ADD COLUMN IF NOT EXISTS veto_key_risk TEXT,
  ADD COLUMN IF NOT EXISTS veto_contradictions JSONB,
  ADD COLUMN IF NOT EXISTS veto_model TEXT,
  ADD COLUMN IF NOT EXISTS veto_latency_ms INT;

ALTER TABLE trading_config
  ADD COLUMN IF NOT EXISTS sector_research_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS veto_layer_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS veto_layer_enforce BOOLEAN DEFAULT FALSE;

COMMIT;
```

- [ ] **Step 2: Apply migration to prod DB**

Use the public proxy URL (NOT `railway run` — it injects the internal hostname).

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener
DATABASE_URL="$DATABASE_URL" \
  psql "$DATABASE_URL" -f database/migration-012-sector-and-veto.sql
```

Expected: `BEGIN`, `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE` × 2, `COMMIT` — all without errors. If `trade_decisions` or `trading_config` doesn't exist, migration-007 hasn't run; abort and investigate.

- [ ] **Step 3: Verify schema**

```bash
DATABASE_URL="$DATABASE_URL" \
  psql "$DATABASE_URL" -c "\d sector_candidates" \
  -c "\d trade_decisions" \
  -c "SELECT sector_research_enabled, veto_layer_enabled, veto_layer_enforce FROM trading_config;"
```

Expected: `sector_candidates` table with 9 columns; `trade_decisions` shows the 7 new `veto_*` columns at the bottom; flags row shows `t | f | f`.

- [ ] **Step 4: Commit**

```bash
git add database/migration-012-sector-and-veto.sql
git commit -m "$(cat <<'EOF'
feat: migration-012 sector_candidates + veto columns + 3 flags

Schema for the classifier augmentation work:
- sector_candidates: daily top-down candidate output
- trade_decisions.veto_*: per-BUY veto verdict + reasoning
- trading_config: sector_research_enabled (default TRUE),
  veto_layer_enabled / veto_layer_enforce (default FALSE)

Spec: docs/superpowers/specs/2026-05-11-classifier-augmentation-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add Anthropic API key to config

**Files:**
- Modify: `backend/src/lib/config.ts`

- [ ] **Step 1: Add `anthropicApiKey` to the zod schema**

In `backend/src/lib/config.ts`, find the `configSchema` block. Add `anthropicApiKey` near `perplexityApiKey`:

```typescript
  // LLM (Perplexity)
  perplexityApiKey: z.string().default(''),

  // LLM (Anthropic) — for sector pass + veto layer
  anthropicApiKey: z.string().default(''),
```

And in the `safeParse` call below, add the env mapping:

```typescript
  perplexityApiKey: process.env.PERPLEXITY_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
```

- [ ] **Step 2: Set the key locally for verification**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
echo 'ANTHROPIC_API_KEY=sk-ant-...your-key...' >> .env
```

- [ ] **Step 3: Verify config loads**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "import { config } from './src/lib/config.js'; console.log('anthropic key present:', config.anthropicApiKey.startsWith('sk-ant-'));"
```

Expected: `anthropic key present: true`.

- [ ] **Step 4: Add the key to Railway**

```bash
# Railway dashboard → backend services (pipeline + returns + sector when it exists)
# Add env var: ANTHROPIC_API_KEY = sk-ant-...
```

Do this in the Railway dashboard for both the existing pipeline service and the returns service. (The new sector cron service in Task 13 will inherit this.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/config.ts
git commit -m "feat: add ANTHROPIC_API_KEY to backend config

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Shared Claude API wrapper

**Files:**
- Create: `backend/src/services/claude.ts`

This wrapper is used by both sector-research and veto. It handles prompt caching, retries, JSON parsing, and cost logging. Keep it minimal — no streaming, no tool use.

- [ ] **Step 1: Write the wrapper**

```typescript
// backend/src/services/claude.ts
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../lib/config.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface ClaudeCallOptions {
  model: 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature?: number;
}

export interface ClaudeCallResult<T> {
  parsed: T | null;
  raw: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMs: number;
  model: string;
  error?: string;
}

// Per-million-token pricing (USD). Update when models change.
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25 },
};

export function estimateCostUsd(r: ClaudeCallResult<unknown>): number {
  const p = PRICING[r.model];
  if (!p) return 0;
  return (
    (r.inputTokens / 1_000_000) * p.input +
    (r.outputTokens / 1_000_000) * p.output +
    (r.cacheReadTokens / 1_000_000) * p.cacheRead +
    (r.cacheCreationTokens / 1_000_000) * p.cacheWrite
  );
}

export async function callClaudeJson<T>(opts: ClaudeCallOptions): Promise<ClaudeCallResult<T>> {
  const started = Date.now();
  try {
    const res = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.2,
      system: [
        {
          type: 'text',
          text: opts.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: opts.userPrompt }],
    });
    const raw =
      res.content[0]?.type === 'text' ? res.content[0].text : '';
    let parsed: T | null = null;
    let parseError: string | undefined;
    try {
      // Strip any markdown fences the model added despite instructions.
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(cleaned) as T;
    } catch (e) {
      parseError = `JSON parse failed: ${(e as Error).message}`;
    }
    const result: ClaudeCallResult<T> = {
      parsed,
      raw,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: res.usage.cache_creation_input_tokens ?? 0,
      latencyMs: Date.now() - started,
      model: opts.model,
      error: parseError,
    };
    const cost = estimateCostUsd(result);
    console.log(
      `[claude] model=${opts.model} in=${result.inputTokens} out=${result.outputTokens} ` +
      `cacheR=${result.cacheReadTokens} cacheW=${result.cacheCreationTokens} ` +
      `latency=${result.latencyMs}ms cost=$${cost.toFixed(4)}` +
      (parseError ? ` parseError="${parseError}"` : '')
    );
    return result;
  } catch (e) {
    const err = (e as Error).message;
    const result: ClaudeCallResult<T> = {
      parsed: null,
      raw: '',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      latencyMs: Date.now() - started,
      model: opts.model,
      error: err,
    };
    console.error(`[claude] model=${opts.model} ERROR: ${err}`);
    return result;
  }
}
```

- [ ] **Step 2: Smoke test the wrapper**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import { callClaudeJson } from './src/services/claude.js';
const r = await callClaudeJson({
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'You output JSON only, no prose.',
  userPrompt: 'Output {\"ok\": true}',
  maxTokens: 50,
});
console.log(JSON.stringify(r, null, 2));
"
```

Expected: A result object with `parsed: { ok: true }`, non-zero `inputTokens` / `outputTokens`, non-zero `latencyMs`, no `error`. The console log line should also print.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/claude.ts
git commit -m "feat: claude.ts wrapper with prompt caching + cost logging

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Sector data fetchers

**Files:**
- Create: `backend/src/services/sector-data.ts`

Three independent fetchers. If any throws, return empty data — the orchestrator decides whether to proceed.

- [ ] **Step 1: Write the fetcher module**

```typescript
// backend/src/services/sector-data.ts
import { fetchWithRetry } from '../lib/http.js';

export interface SectorEtfRow {
  ticker: string;  // e.g. 'XLK'
  sector: string;  // 'Technology'
  change1d: number | null;
  change5d: number | null;
  change1mo: number | null;
  change3mo: number | null;
  volume: number | null;
  avgVolume: number | null;
}

export interface FinvizSectorRow {
  sector: string;
  perfWeek: number | null;
  perfMonth: number | null;
  pctAboveSma50: number | null;
}

export interface NewsItem {
  headline: string;
  source: string;
  publishedAt: string;
}

const SECTOR_ETFS: Array<{ ticker: string; sector: string }> = [
  { ticker: 'XLK', sector: 'Technology' },
  { ticker: 'XLF', sector: 'Financials' },
  { ticker: 'XLE', sector: 'Energy' },
  { ticker: 'XLV', sector: 'Health Care' },
  { ticker: 'XLY', sector: 'Consumer Discretionary' },
  { ticker: 'XLP', sector: 'Consumer Staples' },
  { ticker: 'XLI', sector: 'Industrials' },
  { ticker: 'XLU', sector: 'Utilities' },
  { ticker: 'XLB', sector: 'Materials' },
  { ticker: 'XLRE', sector: 'Real Estate' },
  { ticker: 'XLC', sector: 'Communication Services' },
];

export async function fetchSectorEtfPerf(): Promise<SectorEtfRow[]> {
  const rows: SectorEtfRow[] = [];
  for (const { ticker, sector } of SECTOR_ETFS) {
    try {
      // Yahoo chart endpoint — public, no auth needed
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=3mo&interval=1d`;
      const res = await fetchWithRetry(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const json = await res.json() as any;
      const result = json?.chart?.result?.[0];
      const closes: number[] = result?.indicators?.quote?.[0]?.close ?? [];
      const volumes: number[] = result?.indicators?.quote?.[0]?.volume ?? [];
      const lastClose = closes[closes.length - 1];
      const prevClose = closes[closes.length - 2];
      const close5d = closes[closes.length - 6];
      const close1mo = closes[closes.length - 22];
      const close3mo = closes[0];
      const pct = (from: number | undefined, to: number | undefined): number | null =>
        from && to ? ((to - from) / from) * 100 : null;
      const recentVolumes = volumes.slice(-20).filter((v) => v != null);
      const avgVol =
        recentVolumes.length > 0
          ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length
          : null;
      rows.push({
        ticker,
        sector,
        change1d: pct(prevClose, lastClose),
        change5d: pct(close5d, lastClose),
        change1mo: pct(close1mo, lastClose),
        change3mo: pct(close3mo, lastClose),
        volume: volumes[volumes.length - 1] ?? null,
        avgVolume: avgVol,
      });
    } catch (e) {
      console.warn(`[sector-data] yahoo ${ticker} failed: ${(e as Error).message}`);
    }
    // Polite delay between Yahoo calls
    await new Promise((r) => setTimeout(r, 200));
  }
  return rows;
}

export async function fetchFinvizSectors(): Promise<FinvizSectorRow[]> {
  try {
    const url = 'https://finviz.com/groups.ashx?g=sector&v=110';
    const res = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const html = await res.text();
    // Parse the data rows out of the Finviz HTML. The table-light class is stable.
    // Columns: Name, Market Cap, P/E, ..., Perf Week, Perf Month, ..., # Stocks Above SMA50
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const rows: FinvizSectorRow[] = [];
    const matches = html.matchAll(rowRegex);
    for (const m of matches) {
      const cells: string[] = [];
      const cellMatches = m[1].matchAll(cellRegex);
      for (const c of cellMatches) {
        cells.push(c[1].replace(/<[^>]+>/g, '').trim());
      }
      // First cell is the sector name (link text). Heuristic: row must start with a known sector.
      if (cells.length < 10) continue;
      const sector = cells[1] || cells[0];
      const knownSectors = SECTOR_ETFS.map((s) => s.sector);
      if (!knownSectors.includes(sector)) continue;
      const parsePct = (s: string | undefined): number | null => {
        if (!s) return null;
        const m = s.replace('%', '').trim();
        const n = parseFloat(m);
        return isNaN(n) ? null : n;
      };
      // Finviz v=110 column order may shift; verify mapping the first time by logging cells
      rows.push({
        sector,
        perfWeek: parsePct(cells[7]),   // verify index in smoke test
        perfMonth: parsePct(cells[8]),
        pctAboveSma50: parsePct(cells[10]),
      });
    }
    return rows;
  } catch (e) {
    console.warn(`[sector-data] finviz failed: ${(e as Error).message}`);
    return [];
  }
}

export async function fetchSectorNews(sector: string): Promise<NewsItem[]> {
  try {
    // Google News RSS — public, no auth
    const q = encodeURIComponent(`${sector} sector stocks`);
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetchWithRetry(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const xml = await res.text();
    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const matches = xml.matchAll(itemRegex);
    for (const m of matches) {
      const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(m[1]);
      const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/.exec(m[1]);
      const pubMatch = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(m[1]);
      if (!titleMatch) continue;
      items.push({
        headline: titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
        source: sourceMatch?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() ?? 'unknown',
        publishedAt: pubMatch?.[1]?.trim() ?? '',
      });
      if (items.length >= 8) break;
    }
    return items;
  } catch (e) {
    console.warn(`[sector-data] google news ${sector} failed: ${(e as Error).message}`);
    return [];
  }
}
```

- [ ] **Step 2: Smoke test ETF fetcher**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import { fetchSectorEtfPerf } from './src/services/sector-data.js';
const rows = await fetchSectorEtfPerf();
console.table(rows.map(r => ({ ticker: r.ticker, sector: r.sector, '1d%': r.change1d?.toFixed(2), '5d%': r.change5d?.toFixed(2), '1mo%': r.change1mo?.toFixed(2) })));
console.log('rows:', rows.length);
"
```

Expected: 11 rows, one per sector ETF, with reasonable percentages. If most rows are null on `change1d`, the Yahoo endpoint format has changed — investigate.

- [ ] **Step 3: Smoke test Finviz sectors**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import { fetchFinvizSectors } from './src/services/sector-data.js';
const rows = await fetchFinvizSectors();
console.table(rows);
console.log('rows:', rows.length);
"
```

Expected: 11 sector rows with non-null `perfWeek` / `perfMonth`. If columns look wrong (e.g., `perfWeek` is huge or always null), the Finviz column indices need adjustment. Log raw cells from a known sector and re-map.

- [ ] **Step 4: Smoke test news**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import { fetchSectorNews } from './src/services/sector-data.js';
const items = await fetchSectorNews('Technology');
items.forEach(i => console.log('-', i.headline, '|', i.source));
console.log('items:', items.length);
"
```

Expected: 5-8 headlines about tech / tech stocks. Empty result is acceptable (we proceed without news).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/sector-data.ts
git commit -m "feat: sector-data.ts — Yahoo ETFs + Finviz sectors + Google News

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Sector prompts module

**Files:**
- Create: `backend/src/services/sector-prompts.ts`
- Modify: `backend/src/types/index.ts`

- [ ] **Step 1: Add `SectorCandidate` type**

In `backend/src/types/index.ts`, append (or co-locate with existing source types):

```typescript
export interface SectorCandidate {
  ticker: string;
  sector: string;
  suggestedTier: 'momentum' | 'quality' | 'speculative';
  rationale: string;
  whyNow: string;
}

export interface SectorPassOutput {
  topSectors: Array<{ sector: string; rationale: string }>;
  candidates: SectorCandidate[];
}
```

- [ ] **Step 2: Write `sector-prompts.ts`**

```typescript
// backend/src/services/sector-prompts.ts
import type { SectorEtfRow, FinvizSectorRow, NewsItem } from './sector-data.js';
import type { SectorPassOutput, SectorCandidate } from '../types/index.js';

export const SECTOR_SYSTEM_PROMPT = `You are an equity analyst running a daily top-down sector momentum scan. Your job is to surface 5-8 specific stock tickers across the most momentum-favored sectors for an automated screener that already has bottom-up (social/Finviz) candidates — your value-add is finding names the bottom-up sources miss.

Methodology (synthesized from sector-overview + idea-generation analyst playbooks):

1. SECTOR SELECTION
   - Rank sectors by combined signal: 5-day ETF return, 1-month ETF return, % of names above SMA50, and news catalysts in the last 24h.
   - Pick the top 3 sectors. Avoid sectors with negative breadth (<40% above SMA50) even if 1d return is strong — that's a deadcat bounce signature.
   - Note secular tailwinds you see in the news (AI infra, reshoring, GLP-1, etc.) — these strengthen sector picks.

2. NAME SELECTION (within top sectors)
   - Bias toward names with: leadership in the sector theme, recent positive catalysts, reasonable valuation context, US-listed, market cap > $300M (or > $25M with strong narrative for speculative tier).
   - Avoid: pure social/meme names (the screener already catches those), recently-IPO'd or pre-revenue companies, mega-caps you'd expect anyone to know (AAPL/MSFT/NVDA — pick more differentiated names).
   - Tier assignment:
     - 'quality': market cap > $2B, established company, sector leader
     - 'momentum': market cap $300M-$2B, mid-cap with catalyst
     - 'speculative': market cap < $300M, narrative-driven, high beta

3. FORMAT
   - Output VALID JSON ONLY. No markdown fences, no commentary.
   - For each candidate, rationale = 1-2 sentences on WHY this name fits the sector thesis. why_now = 1 sentence on the specific catalyst making this timely.
   - Falsifiability check: each rationale should reference a specific data point from the input. If you can't, drop the name.

Output schema:
{
  "top_sectors": [{ "sector": string, "rationale": string }],  // 3 entries
  "candidates": [{
    "ticker": string,
    "sector": string,
    "suggested_tier": "momentum" | "quality" | "speculative",
    "rationale": string,
    "why_now": string
  }]  // 5-8 entries
}`;

export function buildSectorUserPrompt(args: {
  etfs: SectorEtfRow[];
  finviz: FinvizSectorRow[];
  newsBySector: Record<string, NewsItem[]>;
  asOfDate: string;
}): string {
  const { etfs, finviz, newsBySector, asOfDate } = args;
  const etfTable = etfs
    .map((r) => `${r.ticker} ${r.sector}: 1d=${fmt(r.change1d)} 5d=${fmt(r.change5d)} 1mo=${fmt(r.change1mo)} 3mo=${fmt(r.change3mo)}`)
    .join('\n');
  const finvizTable = finviz
    .map((r) => `${r.sector}: week=${fmt(r.perfWeek)} month=${fmt(r.perfMonth)} aboveSMA50=${fmt(r.pctAboveSma50)}%`)
    .join('\n');
  const newsBlock = Object.entries(newsBySector)
    .map(([sector, items]) => {
      const headlines = items.slice(0, 5).map((i) => `  - ${i.headline} (${i.source})`).join('\n');
      return `[${sector}]\n${headlines}`;
    })
    .join('\n\n');

  return `As of ${asOfDate} (premarket).

SECTOR ETF PERFORMANCE (Yahoo, % change):
${etfTable}

FINVIZ SECTOR BREADTH:
${finvizTable}

RECENT NEWS BY TOP SECTOR (last 24h headlines):
${newsBlock || '(no news fetched)'}

Identify the top 3 sectors and 5-8 candidate tickers per the methodology in your system prompt. Return JSON only.`;
}

function fmt(n: number | null | undefined): string {
  return n == null ? 'n/a' : n.toFixed(2);
}

export function parseSectorResponse(raw: unknown): SectorPassOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as any;
  if (!Array.isArray(obj.top_sectors) || !Array.isArray(obj.candidates)) return null;
  const candidates: SectorCandidate[] = [];
  for (const c of obj.candidates) {
    if (typeof c.ticker !== 'string') continue;
    if (!['momentum', 'quality', 'speculative'].includes(c.suggested_tier)) continue;
    candidates.push({
      ticker: c.ticker.toUpperCase().trim(),
      sector: typeof c.sector === 'string' ? c.sector : 'Unknown',
      suggestedTier: c.suggested_tier,
      rationale: typeof c.rationale === 'string' ? c.rationale.slice(0, 1000) : '',
      whyNow: typeof c.why_now === 'string' ? c.why_now.slice(0, 500) : '',
    });
  }
  return {
    topSectors: obj.top_sectors
      .filter((s: any) => typeof s.sector === 'string')
      .map((s: any) => ({
        sector: s.sector,
        rationale: typeof s.rationale === 'string' ? s.rationale.slice(0, 1000) : '',
      })),
    candidates,
  };
}
```

- [ ] **Step 3: Smoke test the parser**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import { parseSectorResponse } from './src/services/sector-prompts.js';
const ok = parseSectorResponse({
  top_sectors: [{ sector: 'Technology', rationale: 'broad strength' }],
  candidates: [
    { ticker: 'amd', sector: 'Technology', suggested_tier: 'quality', rationale: 'r', why_now: 'w' },
    { ticker: 'BAD', sector: 'Technology', suggested_tier: 'invalid_tier', rationale: 'r', why_now: 'w' }
  ]
});
console.log(JSON.stringify(ok, null, 2));
"
```

Expected: `topSectors` has 1 entry; `candidates` has 1 entry only (AMD, uppercased — the invalid_tier row is dropped).

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/sector-prompts.ts backend/src/types/index.ts
git commit -m "feat: sector-prompts.ts — system prompt + user builder + parser

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Sector research entry point

**Files:**
- Create: `backend/src/sector-research.ts`
- Modify: `backend/package.json`

- [ ] **Step 1: Write the entry point**

```typescript
// backend/src/sector-research.ts
import db from './db/index.js';
import { callClaudeJson } from './services/claude.js';
import {
  fetchSectorEtfPerf,
  fetchFinvizSectors,
  fetchSectorNews,
} from './services/sector-data.js';
import {
  SECTOR_SYSTEM_PROMPT,
  buildSectorUserPrompt,
  parseSectorResponse,
} from './services/sector-prompts.js';
import type { SectorPassOutput } from './types/index.js';

const SOFT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function main() {
  const startedAt = Date.now();
  console.log('[sector-research] start');

  // Feature flag check
  const cfgRows = await db.query<{ sector_research_enabled: boolean }>(
    'SELECT sector_research_enabled FROM trading_config WHERE id = 1'
  );
  if (!cfgRows[0]?.sector_research_enabled) {
    console.log('[sector-research] disabled via trading_config; exiting');
    await db.close();
    return;
  }

  // Hard timeout — Railway cron must not block subsequent runs
  const timeout = setTimeout(() => {
    console.error('[sector-research] hit soft timeout, force-exit');
    process.exit(1);
  }, SOFT_TIMEOUT_MS);

  try {
    const today = new Date().toISOString().slice(0, 10);

    console.log('[sector-research] fetching ETF performance...');
    const etfs = await fetchSectorEtfPerf();
    console.log(`[sector-research] etfs: ${etfs.length}`);

    console.log('[sector-research] fetching Finviz sectors...');
    const finviz = await fetchFinvizSectors();
    console.log(`[sector-research] finviz: ${finviz.length}`);

    // Pick top 3 sectors by 5d ETF return for news fetch
    const topSectorsForNews = [...etfs]
      .filter((e) => e.change5d != null)
      .sort((a, b) => (b.change5d ?? 0) - (a.change5d ?? 0))
      .slice(0, 3)
      .map((e) => e.sector);
    const newsBySector: Record<string, Array<{ headline: string; source: string; publishedAt: string }>> = {};
    for (const s of topSectorsForNews) {
      newsBySector[s] = await fetchSectorNews(s);
    }
    console.log(`[sector-research] news fetched for ${topSectorsForNews.join(', ')}`);

    if (etfs.length === 0 && finviz.length === 0) {
      console.error('[sector-research] ALL data sources failed; aborting Claude call');
      clearTimeout(timeout);
      await db.close();
      return;
    }

    const userPrompt = buildSectorUserPrompt({
      etfs,
      finviz,
      newsBySector,
      asOfDate: today,
    });

    console.log('[sector-research] calling Claude Sonnet...');
    const result = await callClaudeJson<unknown>({
      model: 'claude-sonnet-4-6',
      systemPrompt: SECTOR_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 2000,
    });

    if (result.error || !result.parsed) {
      console.error('[sector-research] Claude call failed; writing 0 candidates');
      clearTimeout(timeout);
      await db.close();
      return;
    }

    const parsed: SectorPassOutput | null = parseSectorResponse(result.parsed);
    if (!parsed) {
      console.error('[sector-research] response did not match schema; writing 0 candidates');
      clearTimeout(timeout);
      await db.close();
      return;
    }

    console.log(`[sector-research] writing ${parsed.candidates.length} candidates to DB`);
    for (const c of parsed.candidates) {
      await db.query(
        `INSERT INTO sector_candidates (run_date, ticker, sector, rationale, why_now, suggested_tier)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (run_date, ticker) DO UPDATE
           SET sector = EXCLUDED.sector,
               rationale = EXCLUDED.rationale,
               why_now = EXCLUDED.why_now,
               suggested_tier = EXCLUDED.suggested_tier`,
        [today, c.ticker, c.sector, c.rationale, c.whyNow, c.suggestedTier]
      );
    }

    console.log(
      `[sector-research] DONE in ${Math.round((Date.now() - startedAt) / 1000)}s — ` +
      `top sectors: ${parsed.topSectors.map((s) => s.sector).join(', ')}`
    );
  } finally {
    clearTimeout(timeout);
    await db.close();
  }
}

main().catch((e) => {
  console.error('[sector-research] FATAL:', e);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script**

In `backend/package.json`, in the `scripts` block, add:

```json
    "sector-research": "tsx src/sector-research.ts"
```

So the scripts block becomes:

```json
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "pipeline": "tsx src/pipeline-unified.ts",
    "pipeline-legacy": "tsx src/pipeline.ts",
    "sector-research": "tsx src/sector-research.ts",
    "db:migrate": "tsx src/db/migrate.ts",
    "returns": "tsx src/return-tracker.ts"
  },
```

- [ ] **Step 3: Local end-to-end run against prod DB**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
DATABASE_URL="$DATABASE_URL" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  npm run sector-research
```

Expected output:
```
[sector-research] start
[sector-research] etfs: 11
[sector-research] finviz: 11
[sector-research] news fetched for ...
[claude] model=claude-sonnet-4-6 in=... out=... cost=$0.0XXX
[sector-research] writing 5-8 candidates to DB
[sector-research] DONE in ~30-60s
```

If Claude returns garbage JSON: re-run, check the raw response logged by `claude.ts`. Don't iterate on the prompt yet — see Task 7.

- [ ] **Step 4: Verify rows in DB**

```bash
DATABASE_URL="$DATABASE_URL" \
  psql "$DATABASE_URL" -c \
  "SELECT ticker, sector, suggested_tier, why_now FROM sector_candidates WHERE run_date = CURRENT_DATE ORDER BY id;"
```

Expected: 5-8 rows for today with ticker, sector, tier, and one-sentence why_now each.

- [ ] **Step 5: Commit**

```bash
git add backend/src/sector-research.ts backend/package.json
git commit -m "feat: sector-research.ts entry point + npm script

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Pipeline integration — sector candidates as a source

**Files:**
- Modify: `backend/src/pipeline-unified.ts`

The existing pipeline pulls candidates from ApeWisdom, Stocktwits, Finviz, etc., merges by ticker, then runs `selectTopCandidates` with per-source quotas (see commit `6dd41e5`). We add `sector-research` as a new source there.

- [ ] **Step 1: Find the merge step**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
grep -n 'mergeBySource\|selectTopCandidates\|apewisdom-penny' src/pipeline-unified.ts | head -20
```

This tells you which lines to modify. The patterns below assume those functions are private to this file.

- [ ] **Step 2: Add `fetchSectorResearchCandidates` near the other source fetchers**

In `pipeline-unified.ts`, find the block where other sources are fetched (search for `apewisdom-penny` or `fetchApeWisdom`). Above the merge call, add:

```typescript
// Sector research candidates from today's daily cron output.
// Reads-and-marks: returns unused rows AND marks them used_in_run_id in one transaction.
async function fetchSectorResearchCandidates(runId: string): Promise<Array<{ ticker: string; source: string; sector: string; tier: string }>> {
  try {
    const rows = await db.query<{ ticker: string; sector: string; suggested_tier: string }>(
      `WITH picked AS (
         SELECT id, ticker, sector, suggested_tier
         FROM sector_candidates
         WHERE run_date = CURRENT_DATE AND used_in_run_id IS NULL
         FOR UPDATE SKIP LOCKED
       )
       UPDATE sector_candidates sc
          SET used_in_run_id = $1
         FROM picked p
        WHERE sc.id = p.id
       RETURNING p.ticker, p.sector, p.suggested_tier`,
      [runId]
    );
    return rows.map((r) => ({
      ticker: r.ticker.toUpperCase(),
      source: 'sector-research',
      sector: r.sector,
      tier: r.suggested_tier,
    }));
  } catch (e) {
    console.warn(`[pipeline-unified] sector-research fetch failed: ${(e as Error).message}`);
    return [];
  }
}
```

- [ ] **Step 3: Call the fetcher and merge into the candidate pool**

In `pipeline-unified.ts`, find where other source results are combined (look for the `Promise.all` or sequential calls that produce ApeWisdom + Stocktwits + Finviz lists). Add a call to `fetchSectorResearchCandidates(runId)` and merge it into the same per-ticker map by source name `sector-research`.

Concretely, where you see something like:

```typescript
const allMerged = mergeBySource({
  'apewisdom-penny': pennyTickers,
  'apewisdom-all': allTickers,
  'apewisdom-wsb': wsbTickers,
  stocktwits: twitsTickers,
  finviz: finvizTickers,
});
```

extend it to:

```typescript
const sectorTickers = await fetchSectorResearchCandidates(runId);
const allMerged = mergeBySource({
  'apewisdom-penny': pennyTickers,
  'apewisdom-all': allTickers,
  'apewisdom-wsb': wsbTickers,
  stocktwits: twitsTickers,
  finviz: finvizTickers,
  'sector-research': sectorTickers,
});
```

(Field names may differ — match what the existing code uses. The point is: same shape as other sources, plus the source key.)

- [ ] **Step 4: Reserve quota in `selectTopCandidates`**

Find the `selectTopCandidates` function. The quotas block from commit `6dd41e5` looks roughly like:

```typescript
const QUOTAS: Record<string, number> = {
  'apewisdom-penny': 8,
  'apewisdom-all': 4,
  stocktwits: 2,
  earnings_catalyst: 3,
  analyst_upgrade: 3,
  insider_buying: 3,
};
```

Add the new source:

```typescript
const QUOTAS: Record<string, number> = {
  'apewisdom-penny': 8,
  'apewisdom-all': 4,
  stocktwits: 2,
  earnings_catalyst: 3,
  analyst_upgrade: 3,
  insider_buying: 3,
  'sector-research': 4,
};
```

If the quota system in your version differs in name / shape, match the existing pattern. Total of 40 slots minus the quota sum still goes to pure-score selection (currently ~17 → ~13 after our 4 new reserved).

- [ ] **Step 5: Local pipeline dry run to verify sector candidates flow through**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
DATABASE_URL="$DATABASE_URL" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  PERPLEXITY_API_KEY="$PERPLEXITY_API_KEY" \
  FINNHUB_API_KEY="$FINNHUB_API_KEY" \
  ALPHA_VANTAGE_API_KEY="$ALPHA_VANTAGE_API_KEY" \
  ALPACA_API_KEY="$ALPACA_API_KEY" \
  ALPACA_API_SECRET="$ALPACA_API_SECRET" \
  npm run pipeline 2>&1 | tee /tmp/sector-pipeline-test.log
```

(Run after Task 6's sector-research has populated today's rows.)

Expected in log:
- `[pipeline-unified] sector-research: N tickers` (or similar) — must be > 0
- `selectTopCandidates: ... letters: ...` — letter distribution should include sector-pass tickers
- After the run, `SELECT source FROM scan_results WHERE run_id = (SELECT MAX(id) FROM scan_runs) GROUP BY source` should show `sector-research` rows.

Verify with:

```bash
DATABASE_URL='...' psql "$DATABASE_URL" -c \
  "SELECT ticker, source FROM scan_results WHERE run_id = (SELECT MAX(id) FROM scan_runs) AND source LIKE '%sector%' ORDER BY ticker;"
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/pipeline-unified.ts
git commit -m "feat: pipeline picks up sector-research candidates with quota

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Veto prompts module

**Files:**
- Create: `backend/src/services/veto-prompts.ts`
- Modify: `backend/src/types/index.ts`

- [ ] **Step 1: Add veto types**

In `backend/src/types/index.ts`, append:

```typescript
export type VetoVerdict = 'confirm' | 'veto' | 'downgrade_to_watch';

export interface VetoResult {
  verdict: VetoVerdict;
  confidence: number; // 0-100
  reasoning: string;
  keyRisk: string;
  thesisContradictions: string[];
}
```

- [ ] **Step 2: Write the prompts module**

```typescript
// backend/src/services/veto-prompts.ts
import type { VetoResult, VetoVerdict } from '../types/index.js';

export const VETO_SYSTEM_PROMPT = `You are a senior buy-side analyst running a final-veto check on automated stock screener BUY recommendations. The primary classifier (Perplexity Sonar) has already said BUY based on V/C/E lens scores. Your job is one thing: stop bad trades from being placed.

Methodology (synthesized from thesis-tracker + comps-analysis analyst playbooks):

1. PRE-MORTEM
   Imagine this trade lost 15% in 5 days. What would have to be true for that to happen? If the most plausible loss scenario is materially probable given the data, veto.
   Falsifiability test from thesis-tracker: a good thesis is one that could be disproven. If the primary thesis has no specific disconfirming evidence to watch for, the thesis is weak — downgrade.

2. CONTRADICTIONS CHECK
   - Is the V/C/E story internally consistent? (e.g., catalyst score high but no specific catalyst named in thesis → red flag)
   - Does the price action match the thesis? (e.g., "value play" on a stock down 40% YTD without a turnaround signal → red flag)
   - For QUALITY tier: does the analyst target suggest meaningful upside, or are we late?
   - For SPECULATIVE tier: is the volume/sentiment spike fresh (last 1-2 days) or already played out?

3. DISQUALIFIERS (auto-veto)
   - Earnings within 24 hours (existing tradeability filter should catch this — if it slipped through, veto)
   - Active accounting / litigation / regulatory red flags in recent news
   - Pre-revenue + tiny market cap + composite barely above threshold
   - Conviction <= 5 on speculative tier (too random)

4. VERDICT
   - 'confirm': thesis is internally consistent, catalyst is fresh, no disqualifiers, risk/reward is sensible
   - 'veto': clear disqualifier OR plausible pre-mortem path AND thesis has unresolved contradictions
   - 'downgrade_to_watch': thesis is OK but not BUY-grade today (no specific timing catalyst, valuation already extended, or low-conviction setup)

   Default toward 'confirm' unless you have a SPECIFIC concrete reason. We want to catch bad trades, not become a permabear that kills every signal.

5. FORMAT
   - Output VALID JSON ONLY. No markdown fences, no commentary.
   - reasoning = 2-4 sentences explaining the verdict in terms a trader can act on.
   - key_risk = 1 sentence on the single biggest thing that could prove this trade wrong.
   - thesis_contradictions = array of specific contradictions found, [] if none.
   - confidence = 0-100, your confidence in the verdict (not in the trade itself).

Output schema:
{
  "verdict": "confirm" | "veto" | "downgrade_to_watch",
  "confidence": number,
  "reasoning": string,
  "key_risk": string,
  "thesis_contradictions": string[]
}`;

export interface VetoContext {
  ticker: string;
  tier: 'momentum' | 'quality' | 'speculative';
  price: number;
  marketCap: number | null;
  sector: string | null;
  // Perplexity classifier output
  composite: number;
  valueScore: number;
  catalystScore: number;
  upsideScore: number;
  riskScore: number;
  conviction: number;
  category: string;          // e.g. 'insider_signal', 'earnings_event'
  thesis: string;
  edgeWhyNow: string;
  expectedReturnPct: number | null;
  stopLossPct: number | null;
  // Sentiment + price action
  mentionCount: number;
  sourceBreakdown: string;   // 'finviz=3, apewisdom-penny=1' etc.
  change1dPct: number;
  change5dPct: number;
  // Enrichment
  analystTargetMean: number | null;
  daysToEarnings: number | null;
  recentNews: string[];      // 3-5 headlines
}

export function buildVetoUserPrompt(ctx: VetoContext): string {
  const targetUpside =
    ctx.analystTargetMean && ctx.price
      ? `${(((ctx.analystTargetMean - ctx.price) / ctx.price) * 100).toFixed(1)}%`
      : 'n/a';
  const newsBlock = ctx.recentNews.length > 0
    ? ctx.recentNews.map((h, i) => `  ${i + 1}. ${h}`).join('\n')
    : '  (no recent news)';
  return `BUY candidate from automated screener — please run final veto check.

TICKER: ${ctx.ticker}
TIER: ${ctx.tier}
SECTOR: ${ctx.sector ?? 'unknown'}
PRICE: $${ctx.price.toFixed(2)}
MARKET CAP: ${ctx.marketCap ? `$${(ctx.marketCap / 1e6).toFixed(0)}M` : 'unknown'}

CLASSIFIER SCORES (Perplexity):
  composite: ${ctx.composite}/100  (BUY threshold: 45)
  value: ${ctx.valueScore}  catalyst: ${ctx.catalystScore}  upside: ${ctx.upsideScore}  risk: ${ctx.riskScore}
  conviction: ${ctx.conviction}/10  category: ${ctx.category}
  expected_return: ${ctx.expectedReturnPct != null ? ctx.expectedReturnPct.toFixed(1) + '%' : 'n/a'}
  stop_loss: ${ctx.stopLossPct != null ? ctx.stopLossPct.toFixed(1) + '%' : 'n/a'}

THESIS (from Perplexity):
${ctx.thesis}

EDGE / WHY NOW:
${ctx.edgeWhyNow}

PRICE ACTION:
  1d: ${ctx.change1dPct.toFixed(2)}%   5d: ${ctx.change5dPct.toFixed(2)}%

SENTIMENT:
  total mentions: ${ctx.mentionCount}
  sources: ${ctx.sourceBreakdown}

ANALYST CONTEXT:
  mean target: ${ctx.analystTargetMean ? `$${ctx.analystTargetMean.toFixed(2)}` : 'no coverage'}
  implied upside: ${targetUpside}
  days to earnings: ${ctx.daysToEarnings ?? 'n/a'}

RECENT NEWS HEADLINES:
${newsBlock}

Run the veto methodology. Return JSON only.`;
}

export function parseVetoResponse(raw: unknown): VetoResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as any;
  const validVerdicts: VetoVerdict[] = ['confirm', 'veto', 'downgrade_to_watch'];
  if (!validVerdicts.includes(obj.verdict)) return null;
  const confidence = typeof obj.confidence === 'number'
    ? Math.max(0, Math.min(100, Math.round(obj.confidence)))
    : 50;
  return {
    verdict: obj.verdict,
    confidence,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning.slice(0, 2000) : '',
    keyRisk: typeof obj.key_risk === 'string' ? obj.key_risk.slice(0, 500) : '',
    thesisContradictions: Array.isArray(obj.thesis_contradictions)
      ? obj.thesis_contradictions.filter((s: unknown) => typeof s === 'string').slice(0, 10)
      : [],
  };
}
```

- [ ] **Step 3: Smoke test the parser**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
npx tsx -e "
import { parseVetoResponse } from './src/services/veto-prompts.js';
console.log(parseVetoResponse({
  verdict: 'veto',
  confidence: 75,
  reasoning: 'Earnings tomorrow, momentum looks like pre-print hype',
  key_risk: 'Earnings miss is the most likely outcome given guidance walk',
  thesis_contradictions: ['catalyst score 7 but no specific catalyst named']
}));
console.log(parseVetoResponse({ verdict: 'nonsense', confidence: 50 }));  // null
"
```

Expected: first call returns the full object with `verdict: 'veto'`; second call returns `null`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/veto-prompts.ts backend/src/types/index.ts
git commit -m "feat: veto-prompts.ts — pre-mortem methodology system prompt + parser

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Veto service

**Files:**
- Create: `backend/src/services/veto.ts`

- [ ] **Step 1: Write the gate function**

```typescript
// backend/src/services/veto.ts
import { callClaudeJson } from './claude.js';
import {
  VETO_SYSTEM_PROMPT,
  buildVetoUserPrompt,
  parseVetoResponse,
  type VetoContext,
} from './veto-prompts.js';
import type { VetoResult } from '../types/index.js';

export interface VetoCallResult {
  result: VetoResult;          // never null — fail-open default is 'confirm'
  failed: boolean;              // true if Claude errored or returned bad JSON
  errorMessage?: string;
  model: string;
  latencyMs: number;
}

const FAIL_OPEN_RESULT: VetoResult = {
  verdict: 'confirm',
  confidence: 0,                // 0 confidence signals "this is the default, not a real verdict"
  reasoning: 'Veto call failed — defaulting to confirm (fail-open)',
  keyRisk: '',
  thesisContradictions: [],
};

export async function runVeto(ctx: VetoContext): Promise<VetoCallResult> {
  const userPrompt = buildVetoUserPrompt(ctx);
  const res = await callClaudeJson<unknown>({
    model: 'claude-haiku-4-5-20251001',
    systemPrompt: VETO_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 600,
  });

  if (res.error || !res.parsed) {
    return {
      result: FAIL_OPEN_RESULT,
      failed: true,
      errorMessage: res.error ?? 'no parsed response',
      model: res.model,
      latencyMs: res.latencyMs,
    };
  }

  const parsed = parseVetoResponse(res.parsed);
  if (!parsed) {
    return {
      result: FAIL_OPEN_RESULT,
      failed: true,
      errorMessage: 'response did not match schema',
      model: res.model,
      latencyMs: res.latencyMs,
    };
  }

  return {
    result: parsed,
    failed: false,
    model: res.model,
    latencyMs: res.latencyMs,
  };
}
```

- [ ] **Step 2: Smoke test with a synthetic context**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" npx tsx -e "
import { runVeto } from './src/services/veto.js';
const r = await runVeto({
  ticker: 'AAL',
  tier: 'momentum',
  price: 11.13,
  marketCap: 7_300_000_000,
  sector: 'Industrials',
  composite: 46,
  valueScore: 55,
  catalystScore: 60,
  upsideScore: 50,
  riskScore: 35,
  conviction: 7,
  category: 'earnings_event',
  thesis: 'Airline earnings momentum continues; AAL undervalued vs DAL/UAL on fwd P/E',
  edgeWhyNow: 'Q1 earnings beat estimates; sector momentum into summer travel season',
  expectedReturnPct: 12,
  stopLossPct: -8,
  mentionCount: 23,
  sourceBreakdown: 'apewisdom-all=12, finviz=11',
  change1dPct: 2.1,
  change5dPct: 5.4,
  analystTargetMean: 14.50,
  daysToEarnings: 60,
  recentNews: [
    'AAL beats Q1 EPS estimates on strong leisure demand',
    'United, Delta both report strong Q1 — sector momentum continues',
    'AAL announces new transatlantic routes for summer schedule',
  ],
});
console.log(JSON.stringify(r, null, 2));
"
```

Expected: `failed: false`, a `verdict` ('confirm' is most likely for this profile), non-empty reasoning, key_risk, and contradictions array.

- [ ] **Step 3: Smoke test the fail-open path**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
ANTHROPIC_API_KEY="invalid-key-on-purpose" npx tsx -e "
import { runVeto } from './src/services/veto.js';
const r = await runVeto({
  ticker: 'TEST', tier: 'momentum', price: 10, marketCap: null, sector: null,
  composite: 50, valueScore: 50, catalystScore: 50, upsideScore: 50, riskScore: 30, conviction: 6,
  category: 'test', thesis: 't', edgeWhyNow: 'e',
  expectedReturnPct: null, stopLossPct: null,
  mentionCount: 0, sourceBreakdown: '', change1dPct: 0, change5dPct: 0,
  analystTargetMean: null, daysToEarnings: null, recentNews: [],
});
console.log(JSON.stringify(r, null, 2));
"
```

Expected: `failed: true`, `result.verdict: 'confirm'`, `result.confidence: 0`, reasoning mentions fail-open.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/veto.ts
git commit -m "feat: veto.ts — fail-open Claude Haiku gate for BUY decisions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Wire veto into trader-unified.ts

**Files:**
- Modify: `backend/src/services/trader-unified.ts`

The trader's BUY path currently goes: `classifyUnified` → composite >= 45 check → `validateRisk` → Alpaca order. We insert the veto between the threshold check and `validateRisk`, with a flag check first.

- [ ] **Step 1: Find the BUY decision point**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
grep -n 'MIN_COMPOSITE\|validateRisk\|classifyUnified\|placeOrder' src/services/trader-unified.ts | head -20
```

You're looking for the block that decides "this is a BUY → place order." It typically looks like:

```typescript
if (classification.composite >= MIN_COMPOSITE && ... ) {
  const riskCheck = await validateRisk(...);
  if (riskCheck.passed) {
    await placeOrder(...);
  }
}
```

- [ ] **Step 2: Load the three veto flags from trading_config**

Find the function that loads `trading_config` (likely `loadTradingConfig` or similar). Add the three new flags to the SELECT and the returned interface:

```typescript
// In the loadTradingConfig function (or equivalent):
const row = await db.query<{
  enabled: boolean;
  max_risk: number;
  // ...existing fields
  sector_research_enabled: boolean;
  veto_layer_enabled: boolean;
  veto_layer_enforce: boolean;
}>(
  `SELECT enabled, max_risk, /* ... */,
          sector_research_enabled, veto_layer_enabled, veto_layer_enforce
   FROM trading_config WHERE id = 1`
);
```

And in the `TradingConfig` interface in `types/index.ts`:

```typescript
export interface TradingConfig {
  // ...existing fields
  sectorResearchEnabled: boolean;
  vetoLayerEnabled: boolean;
  vetoLayerEnforce: boolean;
}
```

Map them in the loader:

```typescript
return {
  // ...existing fields
  sectorResearchEnabled: row[0].sector_research_enabled,
  vetoLayerEnabled: row[0].veto_layer_enabled,
  vetoLayerEnforce: row[0].veto_layer_enforce,
};
```

- [ ] **Step 3: Insert the veto gate**

Above the BUY block, import `runVeto` and the context type. Then inside the BUY block, before `validateRisk`:

```typescript
import { runVeto } from './veto.js';
import type { VetoContext } from './veto-prompts.js';

// ... inside the trader loop, when classification looks like BUY:

let vetoResult: Awaited<ReturnType<typeof runVeto>> | null = null;

if (tradingConfig.vetoLayerEnabled) {
  const vetoCtx: VetoContext = {
    ticker: candidate.ticker,
    tier: candidate.tier,
    price: candidate.price,
    marketCap: candidate.marketCap ?? null,
    sector: candidate.sector ?? null,
    composite: classification.composite,
    valueScore: classification.valueScore,
    catalystScore: classification.catalystScore,
    upsideScore: classification.upsideScore,
    riskScore: classification.riskScore,
    conviction: classification.conviction,
    category: classification.category,
    thesis: classification.thesis ?? '',
    edgeWhyNow: classification.edgeWhyNow ?? '',
    expectedReturnPct: classification.expectedReturnPct ?? null,
    stopLossPct: classification.stopLossPct ?? null,
    mentionCount: candidate.mentionCount ?? 0,
    sourceBreakdown: candidate.sourceBreakdown ?? '',
    change1dPct: candidate.change1dPct ?? 0,
    change5dPct: candidate.change5dPct ?? 0,
    analystTargetMean: candidate.analystTargetMean ?? null,
    daysToEarnings: candidate.daysToEarnings ?? null,
    recentNews: candidate.recentNews ?? [],
  };

  vetoResult = await runVeto(vetoCtx);
  console.log(
    `[trader] veto ${candidate.ticker}: verdict=${vetoResult.result.verdict} ` +
    `confidence=${vetoResult.result.confidence} failed=${vetoResult.failed} ` +
    `latency=${vetoResult.latencyMs}ms`
  );
}

const vetoBlocks =
  tradingConfig.vetoLayerEnabled &&
  tradingConfig.vetoLayerEnforce &&
  vetoResult != null &&
  !vetoResult.failed &&
  vetoResult.result.verdict !== 'confirm';

// Build the trade_decisions row with veto columns populated regardless of enforce mode
const decisionRow = {
  // ...existing columns
  veto_verdict: vetoResult?.result.verdict ?? null,
  veto_confidence: vetoResult?.result.confidence ?? null,
  veto_reasoning: vetoResult?.result.reasoning ?? null,
  veto_key_risk: vetoResult?.result.keyRisk ?? null,
  veto_contradictions: vetoResult ? JSON.stringify(vetoResult.result.thesisContradictions) : null,
  veto_model: vetoResult?.model ?? null,
  veto_latency_ms: vetoResult?.latencyMs ?? null,
};

if (vetoBlocks) {
  console.log(`[trader] BUY BLOCKED by veto: ${candidate.ticker} (${vetoResult!.result.verdict})`);
  // Write decision row with veto data; do NOT call validateRisk / placeOrder
  await persistTradeDecision({ ...decisionRow, decision_type: 'BUY', placed: false });
  continue;
}

// Existing risk check + order placement, but include veto columns in the persisted row
```

Adjust column names (`decision_type`, `placed`, etc.) to match what `persistTradeDecision` (or its equivalent in your code) already expects. The 7 new veto columns are added; nothing existing changes.

- [ ] **Step 4: Local test in shadow mode**

Pre-flight: set `veto_layer_enabled=TRUE` and `veto_layer_enforce=FALSE` in trading_config so the veto runs and logs but does not block:

```bash
DATABASE_URL="$DATABASE_URL" \
  psql "$DATABASE_URL" -c \
  "UPDATE trading_config SET veto_layer_enabled = TRUE, veto_layer_enforce = FALSE WHERE id = 1;"
```

Run the pipeline locally:

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener/backend
DATABASE_URL='...' ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" PERPLEXITY_API_KEY="$PERPLEXITY_API_KEY" \
  FINNHUB_API_KEY="$FINNHUB_API_KEY" ALPHA_VANTAGE_API_KEY="$ALPHA_VANTAGE_API_KEY" \
  ALPACA_API_KEY="$ALPACA_API_KEY" ALPACA_API_SECRET="$ALPACA_API_SECRET" \
  npm run pipeline 2>&1 | grep -i 'veto\|BUY'
```

Expected: For every BUY classified by Perplexity, you see `[trader] veto TICKER: verdict=... confidence=... failed=false`. No `[trader] BUY BLOCKED` because enforce is off. Alpaca orders still fire normally.

Verify veto columns landed in DB:

```bash
DATABASE_URL='...' psql "$DATABASE_URL" -c \
  "SELECT ticker, decision_type, veto_verdict, veto_confidence, LEFT(veto_reasoning, 80) AS reasoning_excerpt
   FROM trade_decisions
   WHERE run_id = (SELECT MAX(id) FROM scan_runs)
     AND veto_verdict IS NOT NULL
   ORDER BY id;"
```

Expected: Every BUY row has a `veto_verdict` and a reasoning excerpt.

Reset flag for safety:

```bash
DATABASE_URL='...' psql "$DATABASE_URL" -c \
  "UPDATE trading_config SET veto_layer_enabled = FALSE WHERE id = 1;"
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/trader-unified.ts backend/src/types/index.ts
git commit -m "feat: wire veto layer into trader-unified.ts (gated by 2 flags)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Railway cron service for sector research

**Files:**
- Create: `backend/railway.sector.toml`

- [ ] **Step 1: Write the cron config**

```toml
# backend/railway.sector.toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "npm run sector-research"
restartPolicyType = "never"

# Run daily at 8am ET (13:00 UTC) — before the first 14:00 UTC pipeline cron of the day
# so today's sector candidates are available when the pipeline picks them up.
[cron]
schedule = "0 13 * * 1-5"
```

- [ ] **Step 2: Create the new Railway service**

In the Railway dashboard:

1. Open the existing stock-screener project
2. Click "+ New" → "Empty Service" → name it "stock-screener-sector"
3. Connect it to the same GitHub repo
4. In service settings → "Config-as-Code" → set the path to `backend/railway.sector.toml`
5. Copy ALL env vars from the existing pipeline service (DATABASE_URL, ANTHROPIC_API_KEY, FINNHUB_API_KEY, etc. — sector-research only strictly needs DATABASE_URL + ANTHROPIC_API_KEY, but match for consistency)
6. Trigger a deploy

- [ ] **Step 3: Manually trigger one run to verify**

In the Railway service dashboard, click "Trigger Cron" (or wait until next 13:00 UTC if today is a weekday).

Watch the logs — should show the same successful run pattern from Task 6 Step 3.

- [ ] **Step 4: Verify candidates landed**

```bash
DATABASE_URL='...' psql "$DATABASE_URL" -c \
  "SELECT run_date, COUNT(*) FROM sector_candidates GROUP BY run_date ORDER BY run_date DESC LIMIT 5;"
```

Expected: Today's date in the most recent row, with 5-8 candidates.

- [ ] **Step 5: Commit**

```bash
git add backend/railway.sector.toml
git commit -m "feat: railway.sector.toml — daily sector research cron config

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Push everything + run shadow-mode rollout

This task has no code changes — it is the operational rollout. Mark each step done as the rollout proceeds. Span: 1-2 hours work + 5 trading days of shadow observation.

- [ ] **Step 1: Push all commits to GitHub**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/Sites/stock-screener
git push origin main
```

Railway will auto-deploy the backend service. The new sector service deploys via the config-as-code path you set in Task 11.

- [ ] **Step 2: Day 0 — verify all four services come up clean**

In Railway dashboard, watch deploys for:
- `stock-screener` (pipeline cron) — first scheduled run after deploy should succeed
- `stock-screener-returns` (return tracker) — unaffected, should keep running on schedule
- `stock-screener-sector` (NEW) — should be deployed and waiting for 13:00 UTC

If any service fails to build, check the build logs. Most likely cause: missing env var. Add it and redeploy.

- [ ] **Step 3: Day 1 (next trading day premarket) — verify sector pass writes**

After 13:00 UTC:

```bash
DATABASE_URL='...' psql "$DATABASE_URL" -c \
  "SELECT ticker, sector, suggested_tier, LEFT(why_now, 60) FROM sector_candidates WHERE run_date = CURRENT_DATE;"
```

Expected: 5-8 rows.

After 14:00 UTC (first pipeline cron run):

```bash
DATABASE_URL='...' psql "$DATABASE_URL" -c \
  "SELECT ticker, source FROM scan_results WHERE run_id = (SELECT MAX(id) FROM scan_runs) AND source LIKE '%sector%';"
```

Expected: Some of the sector candidates flow through into the pipeline. Maybe not all 5-8 if they failed enrichment / tradeability, but at least 1-2.

- [ ] **Step 4: Day 1 afternoon — flip veto into shadow mode**

```bash
DATABASE_URL='...' psql "$DATABASE_URL" -c \
  "UPDATE trading_config SET veto_layer_enabled = TRUE, veto_layer_enforce = FALSE WHERE id = 1;"
```

Verify in next pipeline cron logs:

```
Railway dashboard → stock-screener service → logs → search "veto"
```

Should see `[trader] veto TICKER: verdict=...` for each BUY.

- [ ] **Step 5: Days 2-6 — let shadow mode run**

No action needed. Veto logs to `trade_decisions` but does not block trades.

- [ ] **Step 6: Day 7 — analyze veto cohort vs confirm cohort**

```sql
-- Requires return-tracker to have populated return_5d on the relevant rows.
SELECT
  td.veto_verdict,
  COUNT(*) AS n,
  ROUND(100.0 * AVG(CASE WHEN sr.return_5d > 0 THEN 1 ELSE 0 END), 1) AS win_rate_pct,
  ROUND(AVG(sr.return_5d)::numeric, 2) AS avg_5d_return_pct
FROM trade_decisions td
JOIN scan_results sr ON sr.ticker = td.ticker AND sr.run_id = td.run_id
WHERE td.veto_verdict IS NOT NULL
  AND sr.return_5d IS NOT NULL
GROUP BY td.veto_verdict
ORDER BY td.veto_verdict;
```

Apply the spec win condition: enable enforce only if **veto cohort win rate is at least 15 pp lower than confirm cohort AND veto cohort avg 5d return is negative**.

- [ ] **Step 7: If win condition met, enable enforcement**

```bash
DATABASE_URL='...' psql "$DATABASE_URL" -c \
  "UPDATE trading_config SET veto_layer_enforce = TRUE WHERE id = 1;"
```

If win condition NOT met, leave enforce off and revisit the prompt (Task 8 Step 2) — but do not iterate inside this plan; that's a follow-up.

- [ ] **Step 8: Update memory + close out**

Update `~/.claude/projects/-Applications-XAMPP-xamppfiles-htdocs-Sites/memory/stock-screener.md` with a one-paragraph note: rollout date, veto win condition result, enforce on/off. This is what future-you reads when this comes up again.

---

## Self-Review Checklist

Before handing this off:

1. **Spec coverage**: Sector pass (Tasks 4-7, 11), veto layer (Tasks 8-10), schema (Task 1), config (Task 2), shared wrapper (Task 3), rollout (Task 12). All sections of the spec map to tasks. ✓
2. **No placeholders**: All steps contain concrete commands, code, or SQL. No "TBD" or "add appropriate handling" without code.
3. **Type consistency**: `SectorCandidate`, `VetoVerdict`, `VetoResult` defined in Tasks 5/8 (types/index.ts), referenced in Tasks 6/9/10 with matching field names (`suggestedTier`, `whyNow`, `verdict`, `keyRisk`, `thesisContradictions`).
4. **Reversibility**: Every code change is behind a flag (`sector_research_enabled`, `veto_layer_enabled`, `veto_layer_enforce`). Flip flags to FALSE and pipeline reverts to current behavior.
