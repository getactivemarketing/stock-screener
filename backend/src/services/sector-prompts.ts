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
