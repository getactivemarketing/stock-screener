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
