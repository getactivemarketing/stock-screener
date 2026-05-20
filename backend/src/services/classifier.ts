import OpenAI from 'openai';
import { config } from '../lib/config.js';
import type {
  Scores,
  MergedSentiment,
  PriceData,
  FundamentalData,
  Classification,
  ClassifierEnrichment,
  Tier,
  DualTierClassificationResult,
  ComponentScores,
  UnifiedClassification,
  YahooQuoteSummary,
} from '../types/index.js';

// Perplexity uses OpenAI-compatible API
const perplexity = new OpenAI({
  apiKey: config.perplexityApiKey,
  baseURL: 'https://api.perplexity.ai',
});

interface TickerContext {
  ticker: string;
  tier: Tier;
  scores: Scores;
  sentiment: MergedSentiment;
  price: PriceData;
  fundamentals: FundamentalData;
  enrichment?: ClassifierEnrichment;
  preliminaryClassification: Classification;
}

export async function generateAnalysis(context: TickerContext): Promise<DualTierClassificationResult> {
  const prompt = buildPrompt(context);

  try {
    const response = await perplexity.chat.completions.create({
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'You are a professional equity analyst. Respond only with valid JSON, no markdown or explanation.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1500,
      temperature: 0.2,
    });

    const responseText = response.choices[0]?.message?.content || '';
    return parseResponse(responseText, context.preliminaryClassification, context.price.price, context.tier);
  } catch (error) {
    console.error(`Perplexity analysis failed for ${context.ticker}:`, error);
    return parseResponse('{}', context.preliminaryClassification, context.price.price, context.tier);
  }
}

function buildPrompt(context: TickerContext): string {
  const { ticker, tier, scores, sentiment, price, fundamentals, enrichment } = context;

  const analystRatings = enrichment?.analystRatings
    ? `${enrichment.analystRatings.summary}${enrichment.analystRatings.meanTarget ? ` | Mean target: $${enrichment.analystRatings.meanTarget.toFixed(2)}` : ''}`
    : 'No analyst coverage';

  const earningsDate = enrichment?.earnings?.nextDate || 'Unknown';
  const daysToEarnings = enrichment?.earnings?.daysToEarnings !== null && enrichment?.earnings?.daysToEarnings !== undefined
    ? `${enrichment.earnings.daysToEarnings}` : 'Unknown';

  const headlines = enrichment?.newsHeadlines?.length
    ? enrichment.newsHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : 'No recent news';

  return `You are a professional equity analyst evaluating stocks for an automated momentum + value trading strategy. You have been given a stock with the following pre-computed data:

TICKER: ${ticker}
COMPANY: ${fundamentals.name || 'Unknown'}
SECTOR: ${fundamentals.sector || 'Unknown'}
PRICE: $${price.price.toFixed(2)} | CHANGE: ${price.change1dPercent.toFixed(2)}%
MARKET CAP: $${formatMarketCap(fundamentals.marketCap)}
AVG DAILY VOLUME: ${Math.round(price.avgVolume30d).toLocaleString()}
TIER: ${tier}
ATTENTION SCORE: ${scores.attention}/100
MOMENTUM SCORE: ${scores.momentum}/100
FUNDAMENTALS SCORE: ${scores.fundamentals}/100
RISK SCORE: ${scores.risk}/100 (lower = safer)
RSI: N/A | MACD: N/A | Volume vs Avg: ${price.relativeVolume.toFixed(2)}x
ANALYST RATINGS: ${analystRatings}
UPCOMING EARNINGS: ${earningsDate} (${daysToEarnings} days away)
RECENT NEWS HEADLINES:
${headlines}

---

TIER CONTEXT — read this before evaluating:

If TIER = "MOMENTUM":
This is a retail-driven penny stock under $20. The edge here is social sentiment + short-term price momentum.
Prioritize: attention velocity (mentions accelerating), relative volume spikes, technical breakout setups,
short squeeze potential, and imminent catalysts (earnings, FDA, PR).
Fundamentals matter less — focus on whether the attention is building toward a move.
Typical hold: 1-5 days. Target return: 10-30%.

If TIER = "QUALITY":
This is a mid-cap stock with real liquidity and institutional coverage. The edge here is mispricing + catalysts
that the market hasn't fully priced in.
Prioritize: undervaluation vs. sector peers (forward P/E, P/S, EV/EBITDA), upcoming earnings with
beatable consensus estimates, emerging industry tailwinds (AI infrastructure, defense, energy transition,
biotech pipeline, GLP-1/obesity, US reshoring), and technical entry points (pullback from highs, RSI reset).
Fundamentals matter a lot — look for a quality business at a reasonable price with a near-term catalyst.
Typical hold: 3-20 days. Target return: 8-25%.

---

Evaluate this stock across THREE lenses:

LENS 1 — VALUE: Is this stock undervalued relative to its fundamentals or peers?
- MOMENTUM tier: Is the price compressed/beaten-down relative to recent range? Low float + high short interest?
- QUALITY tier: Forward P/E below sector median? Price-to-book below 1.5? Revenue growth not yet in price?
  Trading below analyst consensus target?

LENS 2 — CATALYST: Is there an imminent price catalyst within 1-30 days?
Look for: earnings (especially if beatable or with guidance revision potential), FDA decisions, contract
wins, partnerships, product launches, index inclusion, analyst upgrades, short squeeze setup, or major
macro event that directly benefits this company.

LENS 3 — EMERGING INDUSTRY: Is this company operating in a high-growth secular trend?
Look for: AI infrastructure (power, chips, data centers), energy transition (nuclear, solar, grid storage),
defense/aerospace ramp, biotech pipeline, quantum computing, robotics/automation, US reshoring/manufacturing,
GLP-1/obesity drugs, cybersecurity. A company riding a secular tailwind has a higher floor on any pullback.

---

Score each lens 0-10, produce your classification and trading plan, and respond ONLY in this exact JSON format:

{
  "classification": "runner" | "value" | "both" | "watch" | "avoid",
  "tier": "${tier}",
  "confidence": 0.0-1.0,
  "value_score": 0-10,
  "catalyst_score": 0-10,
  "emerging_industry_score": 0-10,
  "thesis": "2-3 sentences. For MOMENTUM stocks: focus on attention setup and technical trigger. For QUALITY stocks: cite specific valuation metrics, the mispricing, and what unlocks it. Always include at least one real number.",
  "edge_why_now": "1-2 sentences on why THIS WEEK is the right time.",
  "bull_case": "Best-case outcome and what drives it (1-2 sentences).",
  "bear_case": "What invalidates the thesis (1 sentence).",
  "key_risk": "The single most important risk to monitor.",
  "catalysts": ["list", "of", "specific", "upcoming", "catalysts"],
  "industry_theme": "Name the macro trend or null.",
  "trade_rationale": "One punchy sentence a trader would say out loud.",
  "suggested_position_pct": 5-15,
  "target_price": {
    "target": 0.00,
    "reasoning": "Brief target reasoning.",
    "confidence": 0.0-1.0
  },
  "stop_loss_pct": -10 to -20,
  "expected_returns": {
    "1m": "+X%",
    "3m": "+X%",
    "12m": "+X%"
  }
}

CLASSIFICATION RULES:
- "runner": Strong momentum + imminent catalyst OR accelerating retail attention. Primarily for MOMENTUM tier.
- "value": Fundamentally undervalued with a near-term catalyst to unlock it. Primarily for QUALITY tier.
- "both": Meets runner AND value criteria. Rare — highest conviction across both tiers.
- "watch": Interesting but missing one key ingredient. Set an alert, don't act yet.
- "avoid": No clear edge in any lens, or risk score too high with no offsetting thesis.

POSITION SIZING GUIDANCE:
- MOMENTUM tier: default 5-10% (higher volatility, shorter hold, smaller size)
- QUALITY tier: default 10-15% (higher conviction, longer hold, larger size justified)
- High conviction (all lens scores >= 7, risk score < 30): can go to 15%

Do not hallucinate financials. If data for a lens is missing or uncertain, score it 0 and reduce confidence accordingly.`;
}

function parseResponse(
  response: string,
  fallbackClassification: Classification,
  currentPrice: number,
  tier: Tier
): DualTierClassificationResult {
  try {
    let jsonStr = response.trim();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const p = JSON.parse(jsonStr);

    return {
      classification: validateClassification(p.classification) || fallbackClassification,
      tier,
      confidence: typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0.5,
      valueScore: typeof p.value_score === 'number' ? Math.max(0, Math.min(10, Math.round(p.value_score))) : 0,
      catalystScore: typeof p.catalyst_score === 'number' ? Math.max(0, Math.min(10, Math.round(p.catalyst_score))) : 0,
      emergingIndustryScore: typeof p.emerging_industry_score === 'number' ? Math.max(0, Math.min(10, Math.round(p.emerging_industry_score))) : 0,
      thesis: typeof p.thesis === 'string' ? p.thesis : 'Analysis unavailable',
      edgeWhyNow: typeof p.edge_why_now === 'string' ? p.edge_why_now : '',
      bullCase: typeof p.bull_case === 'string' ? p.bull_case : 'Analysis unavailable',
      bearCase: typeof p.bear_case === 'string' ? p.bear_case : 'Analysis unavailable',
      keyRisk: typeof p.key_risk === 'string' ? p.key_risk : '',
      catalysts: Array.isArray(p.catalysts) ? p.catalysts.filter((c: unknown) => typeof c === 'string') : [],
      industryTheme: typeof p.industry_theme === 'string' ? p.industry_theme : null,
      tradeRationale: typeof p.trade_rationale === 'string' ? p.trade_rationale : '',
      suggestedPositionPct: typeof p.suggested_position_pct === 'number' ? Math.max(0, Math.min(15, p.suggested_position_pct)) : (tier === 'QUALITY' ? 10 : 5),
      targetPrice: {
        target: p.target_price?.target && typeof p.target_price.target === 'number'
          ? Math.round(p.target_price.target * 100) / 100
          : Math.round(currentPrice * 1.15 * 100) / 100,
        reasoning: typeof p.target_price?.reasoning === 'string' ? p.target_price.reasoning : 'Default target',
        confidence: typeof p.target_price?.confidence === 'number' ? Math.max(0, Math.min(1, p.target_price.confidence)) : 0.4,
      },
      stopLossPct: typeof p.stop_loss_pct === 'number' ? Math.max(-30, Math.min(-5, p.stop_loss_pct)) : (tier === 'QUALITY' ? -12 : -15),
      expectedReturns: {
        oneMonth: typeof p.expected_returns?.['1m'] === 'string' ? p.expected_returns['1m'] : 'N/A',
        threeMonth: typeof p.expected_returns?.['3m'] === 'string' ? p.expected_returns['3m'] : 'N/A',
        twelveMonth: typeof p.expected_returns?.['12m'] === 'string' ? p.expected_returns['12m'] : 'N/A',
      },
    };
  } catch (error) {
    console.error('Failed to parse Perplexity response:', error);
    return {
      classification: fallbackClassification,
      tier,
      confidence: 0.3,
      valueScore: 0,
      catalystScore: 0,
      emergingIndustryScore: 0,
      thesis: 'Analysis parsing failed',
      edgeWhyNow: '',
      bullCase: 'Analysis unavailable',
      bearCase: 'Analysis unavailable',
      keyRisk: '',
      catalysts: [],
      industryTheme: null,
      tradeRationale: '',
      suggestedPositionPct: 5,
      targetPrice: {
        target: Math.round(currentPrice * 1.15 * 100) / 100,
        reasoning: 'Default target (analysis failed)',
        confidence: 0.2,
      },
      stopLossPct: -15,
      expectedReturns: { oneMonth: 'N/A', threeMonth: 'N/A', twelveMonth: 'N/A' },
    };
  }
}

function validateClassification(value: unknown): Classification | null {
  const valid: Classification[] = ['runner', 'value', 'both', 'avoid', 'watch'];
  return valid.includes(value as Classification) ? (value as Classification) : null;
}

function formatMarketCap(value: number): string {
  if (value >= 1_000_000_000) return (value / 1_000_000_000).toFixed(2) + 'B';
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + 'M';
  if (value >= 1_000) return (value / 1_000).toFixed(2) + 'K';
  return value.toString();
}

// ── Unified Classifier (2026-04-08) ─────────────────────

interface UnifiedContext {
  ticker: string;
  price: PriceData;
  fundamentals: FundamentalData;
  yahoo: YahooQuoteSummary | null;
  enrichment?: ClassifierEnrichment;
  scores: ComponentScores;
  // Populated only when the ticker entered the pipeline via the daily
  // sector-research cron. The catalyst score formula is earnings-driven
  // (up to 30 pts for d2e<=5); sector-momentum candidates need this
  // context to give the AI a fair shot at conviction.
  sectorContext?: {
    sector?: string;
    tier?: string;
    rationale?: string;
    whyNow?: string;
  };
}

export async function generateUnifiedAnalysis(
  ctx: UnifiedContext
): Promise<UnifiedClassification> {
  const prompt = buildUnifiedPrompt(ctx);
  try {
    const response = await perplexity.chat.completions.create({
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'You are a professional equity analyst focused on value + catalyst setups. Respond only with valid JSON, no markdown or explanation.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1200,
      temperature: 0.2,
    });
    const text = response.choices[0]?.message?.content || '';
    return parseUnifiedResponse(text, ctx.scores);
  } catch (error) {
    console.error(`Perplexity unified analysis failed for ${ctx.ticker}:`, error);
    return parseUnifiedResponse('{}', ctx.scores);
  }
}

function buildUnifiedPrompt(ctx: UnifiedContext): string {
  const { ticker, price, fundamentals, yahoo, enrichment, scores, sectorContext } = ctx;

  const analystLine = yahoo?.targetMeanPrice
    ? `Mean target $${yahoo.targetMeanPrice.toFixed(2)} (${yahoo.numberOfAnalystOpinions} analysts), rec mean ${yahoo.recommendationMean ?? 'n/a'}`
    : 'No analyst coverage';

  const dte = enrichment?.earnings?.daysToEarnings;
  const earningsLine = dte != null
    ? `${enrichment?.earnings?.nextDate} (${dte} days away, beat rate ${enrichment?.earnings?.earningsBeatRate ?? 'n/a'}%)`
    : 'No upcoming earnings within 90 days';

  const insider = enrichment?.insiderActivity;
  const insiderLine = insider
    ? `Large buy 90d: ${insider.largeBuy90d}, any buy 90d: ${insider.anyBuy90d}, net selling: ${insider.netSelling}`
    : 'No insider data';

  const headlines = enrichment?.newsHeadlines?.length
    ? enrichment.newsHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : 'No recent news';

  const upsidePct = yahoo?.targetMeanPrice && price.price > 0
    ? (((yahoo.targetMeanPrice - price.price) / price.price) * 100).toFixed(1) + '%'
    : 'n/a';

  return `You are evaluating a stock for a systematic value + catalyst trading strategy. The screener has already computed component scores; your job is to verify the thesis with qualitative judgment and recent news.

TICKER: ${ticker}
COMPANY: ${fundamentals.name || 'Unknown'}
SECTOR: ${fundamentals.sector || 'Unknown'}
PRICE: $${price.price.toFixed(2)}  |  Market Cap: $${formatMarketCap(fundamentals.marketCap)}
P/E: ${fundamentals.peRatio ?? 'n/a'}  |  P/B: ${fundamentals.pbRatio ?? 'n/a'}  |  Rev growth: ${fundamentals.revenueGrowth != null ? (fundamentals.revenueGrowth * 100).toFixed(1) + '%' : 'n/a'}
Op margin: ${fundamentals.operatingMargin != null ? (fundamentals.operatingMargin * 100).toFixed(1) + '%' : 'n/a'}  |  Debt/Equity: ${fundamentals.debtEquity ?? 'n/a'}
Analyst: ${analystLine}  |  Upside to target: ${upsidePct}
Earnings: ${earningsLine}
Insiders: ${insiderLine}
Recent news:
${headlines}
${sectorContext ? `
SECTOR-RESEARCH FLAG: This ticker entered the screener via today's sector-rotation pass — not via social sentiment or organic mention volume. The earnings-driven catalyst score may understate the real setup. Treat the rationale below as part of the catalyst case:
  Sector: ${sectorContext.sector ?? 'Unknown'}  |  Suggested tier: ${sectorContext.tier ?? 'core'}
  Rationale: ${sectorContext.rationale ?? '(none)'}
  Why now: ${sectorContext.whyNow ?? '(none)'}
` : ''}
COMPONENT SCORES (pre-computed, 0-100):
  Value: ${scores.value}  |  Catalyst: ${scores.catalyst}  |  Upside: ${scores.upside}  |  Risk: ${scores.risk}
  Composite: ${scores.composite}

Your job:
1. THESIS — one paragraph: what's the setup? Why is this mispriced AND about to move?
2. VALUE CASE — what makes this cheap relative to fair value? Cite specific numbers.
3. CATALYSTS — list concrete near-term events (earnings, product, legal, macro). Each with an expected date if known.
4. KEY RISKS — what invalidates the thesis?
5. EXPECTED RETURN — realistic 30-day move (%). Be honest, not promotional.
6. CONVICTION — 0-10 scale, factoring both setup quality AND how much the news actually supports the scores.
7. RECOMMENDATION — BUY if thesis is strong and catalyst is imminent; WATCH if interesting but timing unclear; AVOID if the scores are misleading or news reveals a problem.

Respond ONLY in this exact JSON format:

{
  "thesis": "one paragraph, 2-4 sentences, with at least one real number",
  "value_case": "1-2 sentences citing specific valuation metrics vs peers or history",
  "catalysts": [
    { "description": "concrete event", "date": "YYYY-MM-DD or null" }
  ],
  "key_risks": ["risk 1", "risk 2"],
  "expected_return_30d": 0.0,
  "conviction_score": 0,
  "recommendation": "BUY" | "WATCH" | "AVOID"
}

Do not hallucinate. If news contradicts the scores, lower conviction and explain in thesis.`;
}

function parseUnifiedResponse(
  response: string,
  scores: ComponentScores
): UnifiedClassification {
  // Default recommendation based on composite if parsing fails
  const fallbackRec: UnifiedClassification['recommendation'] =
    scores.composite >= 55 && scores.risk <= 45 ? 'BUY'
    : scores.composite < 35 || scores.risk > 60 ? 'AVOID'
    : 'WATCH';

  try {
    let jsonStr = response.trim();
    const m = response.match(/\{[\s\S]*\}/);
    if (m) jsonStr = m[0];
    const p = JSON.parse(jsonStr);

    const rec = ['BUY', 'WATCH', 'AVOID'].includes(p.recommendation)
      ? (p.recommendation as UnifiedClassification['recommendation'])
      : fallbackRec;

    return {
      thesis: typeof p.thesis === 'string' ? p.thesis : 'Analysis unavailable',
      valueCase: typeof p.value_case === 'string' ? p.value_case : '',
      catalysts: Array.isArray(p.catalysts)
        ? p.catalysts
            .filter((c: unknown) => c && typeof c === 'object')
            .map((c: { description?: unknown; date?: unknown }) => ({
              description: typeof c.description === 'string' ? c.description : '',
              date: typeof c.date === 'string' ? c.date : null,
            }))
            .filter((c: { description: string }) => c.description.length > 0)
        : [],
      keyRisks: Array.isArray(p.key_risks)
        ? p.key_risks.filter((r: unknown): r is string => typeof r === 'string')
        : [],
      expectedReturn30d: typeof p.expected_return_30d === 'number'
        ? Math.max(-50, Math.min(100, p.expected_return_30d))
        : 0,
      convictionScore: typeof p.conviction_score === 'number'
        ? Math.max(0, Math.min(10, Math.round(p.conviction_score)))
        : 5,
      recommendation: rec,
    };
  } catch (error) {
    console.error('Failed to parse unified Perplexity response:', error);
    return {
      thesis: 'Analysis parsing failed',
      valueCase: '',
      catalysts: [],
      keyRisks: [],
      expectedReturn30d: 0,
      convictionScore: 3,
      recommendation: fallbackRec,
    };
  }
}

export default {
  generateAnalysis,
  generateUnifiedAnalysis,
};
