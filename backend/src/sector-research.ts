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
