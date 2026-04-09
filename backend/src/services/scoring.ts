import type {
  MergedSentiment,
  PriceData,
  FundamentalData,
  Scores,
  Classification,
  ClassificationResult,
  ClassifierEnrichment,
  Tier,
  ComponentScores,
  YahooQuoteSummary,
} from '../types/index.js';
import { alertConfig } from '../lib/config.js';
import type { TechnicalIndicators } from './technicals.js';
import { getSectorMedianPE as _getSectorMedianPE, getSectorMedianPB } from './sectorMedians.js';

/**
 * Calculate attention score (0-100) based on sentiment data from aggregators
 */
export function calculateAttentionScore(sentiment: MergedSentiment): number {
  const { totalMentions, avgSentiment, maxMomentum, sourceCount, sources } = sentiment;

  // Base score from total mentions (0-40 points)
  // 200+ mentions = max points
  const mentionScore = Math.min(40, (totalMentions / 200) * 40);

  // Sentiment score (0-25 points)
  // avgSentiment ranges from -100 to 100, normalize to 0-25
  const sentimentScore = ((avgSentiment + 100) / 200) * 25;

  // Rank bonus from ApeWisdom (0-20 points). Take the best rank across any ApeWisdom filter.
  let rankScore = 0;
  const apeRanks = [
    sources['apewisdom-penny']?.rank,
    sources['apewisdom-all']?.rank,
    sources['apewisdom-wsb']?.rank,
  ].filter((r): r is number => typeof r === 'number' && r > 0);
  const bestApeRank = apeRanks.length ? Math.min(...apeRanks) : undefined;
  if (bestApeRank) {
    const rank = bestApeRank;
    if (rank <= 10) rankScore = 20;
    else if (rank <= 25) rankScore = 15;
    else if (rank <= 50) rankScore = 10;
    else if (rank <= 100) rankScore = 5;
  }

  // Multi-source bonus (0-5 points)
  // Being mentioned on multiple platforms is a stronger signal
  const sourceBonus = Math.min(5, sourceCount * 2);

  // Momentum bonus (0-10 points)
  // If mentions are accelerating (momentum > 2x), add bonus
  let momentumBonus = 0;
  if (maxMomentum > 3) momentumBonus = 10;
  else if (maxMomentum > 2) momentumBonus = 5;
  else if (maxMomentum > 1.5) momentumBonus = 2;

  const total = mentionScore + sentimentScore + rankScore + sourceBonus + momentumBonus;
  return Math.round(Math.max(0, Math.min(100, total)));
}

/**
 * Calculate momentum score (0-100) based on price action
 */
export function calculateMomentumScore(price: PriceData): number {
  // Daily move score (0-30 points)
  // 15%+ move = max points
  const dailyMoveScore = Math.min(30, Math.abs(price.change1dPercent) * 2);

  // Volume score (0-30 points)
  // 4x+ relative volume = max points
  const volumeScore = Math.min(30, (price.relativeVolume - 1) * 10);

  // Trend score - 30-day performance (0-20 points)
  let trendScore = 0;
  if (price.change30dPercent > 50) trendScore = 20;
  else if (price.change30dPercent > 20) trendScore = 15;
  else if (price.change30dPercent > 0) trendScore = 10;
  else if (price.change30dPercent > -20) trendScore = 5;

  // Position score - room to run (0-20 points)
  // More upside potential if far from 52-week high
  const distanceFromHigh = ((price.high52w - price.price) / price.high52w) * 100;
  let positionScore = 0;
  if (distanceFromHigh > 50) positionScore = 20; // More than 50% below high
  else if (distanceFromHigh > 30) positionScore = 15;
  else if (distanceFromHigh > 15) positionScore = 10;
  else positionScore = 5;

  const total = dailyMoveScore + volumeScore + trendScore + positionScore;
  return Math.round(Math.max(0, Math.min(100, total)));
}

// Sector forward P/E medians (hardcoded v1)
const SECTOR_PE_MEDIANS: Record<string, number> = {
  'Technology': 28,
  'Biotech': 35,
  'Life Sciences': 35,
  'Biotechnology': 35,
  'Energy': 12,
  'Industrials': 18,
  'Healthcare': 22,
  'Financials': 14,
  'Financial Services': 14,
  'Consumer Discretionary': 22,
  'Consumer Cyclical': 22,
  'Consumer Staples': 20,
  'Consumer Defensive': 20,
  'Utilities': 16,
  'Real Estate': 18,
  'Materials': 15,
  'Basic Materials': 15,
  'Communication Services': 20,
};
const DEFAULT_PE_MEDIAN = 20;

function getSectorMedianPELegacy(sector: string): number {
  if (SECTOR_PE_MEDIANS[sector]) return SECTOR_PE_MEDIANS[sector];
  const key = Object.keys(SECTOR_PE_MEDIANS).find(k =>
    sector.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(sector.toLowerCase())
  );
  return key ? SECTOR_PE_MEDIANS[key] : DEFAULT_PE_MEDIAN;
}

/**
 * QUALITY tier fundamentals score (0-100)
 * 30% analyst target distance, 30% relative P/E, 20% earnings beat rate, 20% margins/debt/growth
 */
function computeQualityFundamentals(
  price: number,
  fundamentals: FundamentalData,
  enrichment?: ClassifierEnrichment
): number {
  let score = 0;

  // 1. Price-to-analyst-target distance (0-30 points)
  const meanTarget = enrichment?.analystRatings?.meanTarget;
  if (meanTarget && meanTarget > 0 && price > 0) {
    const impliedUpside = (meanTarget - price) / price;
    score += Math.round(Math.max(0, Math.min(30, (impliedUpside / 0.25) * 30)));
  }

  // 2. Forward P/E vs sector median (0-30 points)
  if (fundamentals.peRatio !== null && fundamentals.peRatio > 0) {
    const sectorMedian = getSectorMedianPELegacy(fundamentals.sector || '');
    const ratio = fundamentals.peRatio / sectorMedian;
    if (ratio <= 0.7) {
      score += 30;
    } else if (ratio <= 1.3) {
      score += Math.round(30 - ((ratio - 0.7) / 0.6) * 30);
    }
  }

  // 3. Earnings beat rate (0-20 points)
  const beatRate = enrichment?.earnings?.earningsBeatRate;
  if (beatRate !== null && beatRate !== undefined) {
    score += Math.round((beatRate / 100) * 20);
  } else {
    score += 10; // Neutral when no data
  }

  // 4. Existing checks scaled to 20 points (0-20)
  let legacyScore = 0;
  if (fundamentals.grossMargin !== null) {
    if (fundamentals.grossMargin > 50) legacyScore += 4;
    else if (fundamentals.grossMargin > 30) legacyScore += 2;
  }
  if (fundamentals.operatingMargin !== null) {
    if (fundamentals.operatingMargin > 20) legacyScore += 4;
    else if (fundamentals.operatingMargin > 0) legacyScore += 2;
    else legacyScore -= 2;
  }
  if (fundamentals.debtEquity !== null) {
    if (fundamentals.debtEquity < 0.3) legacyScore += 4;
    else if (fundamentals.debtEquity > 2) legacyScore -= 4;
    else if (fundamentals.debtEquity > 1) legacyScore -= 2;
  }
  if (fundamentals.revenueGrowth !== null) {
    if (fundamentals.revenueGrowth > 50) legacyScore += 6;
    else if (fundamentals.revenueGrowth > 20) legacyScore += 4;
    else if (fundamentals.revenueGrowth > 0) legacyScore += 2;
    else if (fundamentals.revenueGrowth < -20) legacyScore -= 4;
  }
  if (['NYSE', 'NASDAQ'].some(e => fundamentals.exchange?.includes(e))) {
    legacyScore += 2;
  }
  score += Math.max(0, Math.min(20, legacyScore + 10));

  return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * Calculate fundamentals score (0-100) based on company metrics
 */
function computeMomentumFundamentals(fundamentals: FundamentalData): number {
  let score = 50; // Neutral starting point

  // Market cap tier - larger = more established
  if (fundamentals.marketCap >= 500_000_000) score += 15; // > $500M
  else if (fundamentals.marketCap >= 100_000_000) score += 10; // > $100M
  else if (fundamentals.marketCap >= 50_000_000) score += 5; // > $50M
  else if (fundamentals.marketCap < 10_000_000) score -= 15; // < $10M (shell company risk)

  // Valuation - P/E ratio
  if (fundamentals.peRatio !== null) {
    if (fundamentals.peRatio > 0 && fundamentals.peRatio < 15) score += 10;
    else if (fundamentals.peRatio > 0 && fundamentals.peRatio < 30) score += 5;
    else if (fundamentals.peRatio < 0) score -= 5; // Unprofitable
    else if (fundamentals.peRatio > 100) score -= 5; // Very expensive
  }

  // Revenue growth
  if (fundamentals.revenueGrowth !== null) {
    if (fundamentals.revenueGrowth > 50) score += 15;
    else if (fundamentals.revenueGrowth > 20) score += 10;
    else if (fundamentals.revenueGrowth > 0) score += 5;
    else if (fundamentals.revenueGrowth < -20) score -= 10;
  }

  // Profitability - Gross margin
  if (fundamentals.grossMargin !== null) {
    if (fundamentals.grossMargin > 50) score += 10;
    else if (fundamentals.grossMargin > 30) score += 5;
    else if (fundamentals.grossMargin < 10) score -= 5;
  }

  // Operating margin
  if (fundamentals.operatingMargin !== null) {
    if (fundamentals.operatingMargin > 20) score += 10;
    else if (fundamentals.operatingMargin > 0) score += 5;
    else score -= 5; // Operating at a loss
  }

  // Debt levels
  if (fundamentals.debtEquity !== null) {
    if (fundamentals.debtEquity < 0.3) score += 5; // Low debt
    else if (fundamentals.debtEquity > 2) score -= 10; // High debt
    else if (fundamentals.debtEquity > 1) score -= 5;
  }

  // Exchange quality bonus
  const majorExchanges = ['NYSE', 'NASDAQ'];
  if (majorExchanges.some((e) => fundamentals.exchange?.includes(e))) {
    score += 5;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * Calculate fundamentals score (0-100) — tier-aware
 */
export function calculateFundamentalsScore(
  fundamentals: FundamentalData,
  tier?: Tier,
  price?: number,
  enrichment?: ClassifierEnrichment
): number {
  if (tier === 'QUALITY' && price) {
    return computeQualityFundamentals(price, fundamentals, enrichment);
  }
  return computeMomentumFundamentals(fundamentals);
}

/**
 * Calculate risk score (0-100) - higher = more likely pump & dump
 */
export function calculateRiskScore(
  sentiment: MergedSentiment,
  price: PriceData,
  fundamentals: FundamentalData,
  attentionScore: number,
  fundamentalsScore: number
): number {
  let risk = 20; // Baseline risk for penny stocks

  // High attention + poor fundamentals = red flag
  if (attentionScore > 80 && fundamentalsScore < 30) {
    risk += 25;
  } else if (attentionScore > 60 && fundamentalsScore < 40) {
    risk += 15;
  }

  // Massive volume spike with weak fundamentals
  if (price.relativeVolume > 10 && fundamentalsScore < 50) {
    risk += 20;
  } else if (price.relativeVolume > 5 && fundamentalsScore < 50) {
    risk += 10;
  }

  // Single-source hype (only trending on one platform)
  if (sentiment.sourceCount === 1 && attentionScore > 50) {
    risk += 15;
  }

  // Extreme daily move without strong fundamentals
  if (Math.abs(price.change1dPercent) > 30 && fundamentalsScore < 50) {
    risk += 15;
  }

  // Micro-cap with big move
  if (fundamentals.marketCap < 10_000_000 && Math.abs(price.change1dPercent) > 20) {
    risk += 20;
  }

  // Very small market cap
  if (fundamentals.marketCap < 5_000_000) {
    risk += 10;
  }

  // OTC stocks are inherently riskier
  const otcExchanges = ['OTC', 'PINK', 'OTCQB', 'OTCQX'];
  if (otcExchanges.some((e) => fundamentals.exchange?.includes(e))) {
    risk += 10;
  }

  // No recent SEC filings (if we had this data)
  if (fundamentals.recentFilings === 0) {
    risk += 5;
  }

  return Math.round(Math.max(0, Math.min(100, risk)));
}

/**
 * Calculate all scores for a ticker
 */
export function calculateAllScores(
  sentiment: MergedSentiment,
  price: PriceData,
  fundamentals: FundamentalData,
  tier?: Tier,
  enrichment?: ClassifierEnrichment
): Scores {
  const attention = calculateAttentionScore(sentiment);
  const momentum = calculateMomentumScore(price);
  const fundamentalsScore = calculateFundamentalsScore(fundamentals, tier, price.price, enrichment);
  const risk = calculateRiskScore(sentiment, price, fundamentals, attention, fundamentalsScore);

  return {
    attention,
    momentum,
    fundamentals: fundamentalsScore,
    risk,
  };
}

/**
 * Determine classification and alert type based on scores
 */
export function classifyTicker(scores: Scores): {
  classification: Classification;
  alertType: 'runner' | 'value' | 'both' | 'pump_warning' | null;
  reason: string;
} {
  const { attention, momentum, fundamentals, risk } = scores;

  // High risk = avoid regardless of other scores
  if (risk >= alertConfig.pumpWarning.minRisk) {
    return {
      classification: 'avoid',
      alertType: 'pump_warning',
      reason: 'High pump-and-dump probability',
    };
  }

  // Check for "both" first (rarest and most valuable)
  const isBoth =
    attention >= 60 &&
    momentum >= 60 &&
    fundamentals >= 60 &&
    risk < 50;

  if (isBoth) {
    return {
      classification: 'both',
      alertType: 'both',
      reason: 'Quality company with momentum and attention',
    };
  }

  // Runner: high attention + high momentum
  const isRunner =
    attention >= alertConfig.runner.minAttention &&
    momentum >= alertConfig.runner.minMomentum &&
    risk <= alertConfig.runner.maxRisk;

  if (isRunner) {
    return {
      classification: 'runner',
      alertType: 'runner',
      reason: 'High sentiment momentum play',
    };
  }

  // Value: good fundamentals + moderate momentum
  const isValue =
    fundamentals >= alertConfig.value.minFundamentals &&
    momentum >= alertConfig.value.minMomentum &&
    momentum <= alertConfig.value.maxMomentum &&
    risk <= alertConfig.value.maxRisk;

  if (isValue) {
    return {
      classification: 'value',
      alertType: 'value',
      reason: 'Strong fundamentals with building momentum',
    };
  }

  // Default: watch list
  return {
    classification: 'watch',
    alertType: null,
    reason: 'Does not meet runner or value criteria',
  };
}

export default {
  calculateAttentionScore,
  calculateMomentumScore,
  calculateFundamentalsScore,
  calculateRiskScore,
  calculateAllScores,
  classifyTicker,
};

// ── Unified Screener Scoring (2026-04-08) ──────────────

interface UnifiedScoringInputs {
  sentiment: MergedSentiment;
  price: PriceData;
  fundamentals: FundamentalData;
  yahoo: YahooQuoteSummary | null;
  enrichment: ClassifierEnrichment | undefined;
  technicals: TechnicalIndicators | null;
  finvizHits: number;  // number of distinct Finviz sub-screens this ticker appeared in
}

/**
 * Value score (0-100). Answer: is this mispriced?
 */
export function calculateValueScore(input: UnifiedScoringInputs): number {
  const { price, fundamentals, yahoo } = input;
  let score = 0;

  // Analyst target upside (0-25)
  if (yahoo?.targetMeanPrice && price.price > 0) {
    const upsidePct = ((yahoo.targetMeanPrice - price.price) / price.price) * 100;
    if (upsidePct >= 50) score += 25;
    else if (upsidePct >= 30) score += 18;
    else if (upsidePct >= 15) score += 12;
    else if (upsidePct >= 5) score += 6;
  }

  // Forward revenue growth (0-15)
  const revGrowth = fundamentals.revenueGrowth;
  if (typeof revGrowth === 'number') {
    if (revGrowth >= 0.20) score += 15;
    else if (revGrowth >= 0.10) score += 10;
    else if (revGrowth >= 0.05) score += 6;
    else if (revGrowth >= 0) score += 2;
  }

  // Gross margin level (0-10)
  const gm = fundamentals.grossMargin;
  if (typeof gm === 'number') {
    if (gm >= 0.50) score += 10;
    else if (gm >= 0.35) score += 7;
    else if (gm >= 0.20) score += 4;
  }

  // Operating margin (0-10)
  const om = fundamentals.operatingMargin;
  if (typeof om === 'number') {
    if (om >= 0.20) score += 10;
    else if (om >= 0.10) score += 6;
    else if (om >= 0.05) score += 3;
  }

  // P/E vs sector median (0-20)
  const pe = fundamentals.peRatio;
  if (typeof pe === 'number' && pe > 0) {
    const sectorPE = _getSectorMedianPE(fundamentals.sector);
    const discount = (sectorPE - pe) / sectorPE;
    if (discount >= 0.3) score += 20;
    else if (discount >= 0.15) score += 12;
    else if (discount >= 0) score += 6;
  }

  // P/B vs sector median (0-10)
  const pb = fundamentals.pbRatio;
  if (typeof pb === 'number' && pb > 0) {
    const sectorPB = getSectorMedianPB(fundamentals.sector);
    const discount = (sectorPB - pb) / sectorPB;
    if (discount >= 0.3) score += 10;
    else if (discount >= 0.15) score += 6;
    else if (discount >= 0) score += 3;
  }

  // Distance from 52w high (0-10)
  if (price.high52w > 0 && price.price > 0) {
    const distancePct = ((price.high52w - price.price) / price.high52w) * 100;
    if (distancePct >= 50) score += 10;
    else if (distancePct >= 30) score += 7;
    else if (distancePct >= 15) score += 4;
  }

  return Math.min(100, Math.round(score));
}

/**
 * Catalyst score (0-100). Answer: is something about to happen?
 */
export function calculateCatalystScoreV2(input: UnifiedScoringInputs): number {
  const { enrichment } = input;
  const insider = enrichment?.insiderActivity;
  const insiderLargeBuy90d = insider?.largeBuy90d ?? false;
  const insiderAnyBuy90d = insider?.anyBuy90d ?? false;
  const insiderNetSelling = insider?.netSelling ?? false;
  let score = 0;

  // Days to next earnings (0-30)
  const dte = enrichment?.earnings?.daysToEarnings;
  if (typeof dte === 'number' && dte >= 0) {
    if (dte <= 5) score += 30;
    else if (dte <= 10) score += 25;
    else if (dte <= 20) score += 15;
    else if (dte <= 35) score += 8;
  }

  // Beat rate (0-20)
  const beatRate = enrichment?.earnings?.earningsBeatRate;
  if (typeof beatRate === 'number') {
    if (beatRate >= 100) score += 20;
    else if (beatRate >= 75) score += 15;
    else if (beatRate >= 50) score += 10;
  }

  // Analyst recommendation (0-20)
  const summary = enrichment?.analystRatings?.summary ?? '';
  const strongBuyMatch = /Strong Buy:\s*(\d+)/i.exec(summary);
  const buyMatch = /(?<!Strong )Buy:\s*(\d+)/i.exec(summary);
  const strongBuyCount = strongBuyMatch ? parseInt(strongBuyMatch[1]) : 0;
  const buyCount = buyMatch ? parseInt(buyMatch[1]) : 0;
  const positiveCount = strongBuyCount + buyCount;
  if (strongBuyCount >= 3) score += 20;
  else if (strongBuyCount >= 1 || positiveCount >= 4) score += 15;
  else if (positiveCount >= 2) score += 8;

  // Insider buying (0-20)
  if (insiderLargeBuy90d) score += 20;
  else if (insiderAnyBuy90d) score += 10;
  else if (insiderNetSelling) score -= 5;

  // News recency (0-10)
  const headlines = enrichment?.newsHeadlines ?? [];
  if (headlines.length >= 3) score += 10;
  else if (headlines.length >= 1) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Upside/technical score (0-100). Tailwinds?
 * Note: technicalSignal uses 'bullish'/'bearish'/'neutral' — mapped accordingly.
 */
export function calculateUpsideScore(input: UnifiedScoringInputs): number {
  const { price, technicals, finvizHits } = input;
  let score = 0;

  // Relative volume (0-25)
  const rv = price.relativeVolume ?? 1;
  if (rv >= 3) score += 25;
  else if (rv >= 2) score += 18;
  else if (rv >= 1.5) score += 10;
  else if (rv >= 1) score += 5;

  // 30d price momentum (0-25)
  const mom30 = price.change30dPercent ?? 0;
  if (mom30 >= 20) score += 25;
  else if (mom30 >= 10) score += 18;
  else if (mom30 >= 0) score += 10;
  else if (mom30 >= -10) score += 5;

  // RSI in healthy zone (0-15): 35-65 is sweet spot
  const rsi = technicals?.rsi14;
  if (typeof rsi === 'number') {
    if (rsi >= 40 && rsi <= 60) score += 15;
    else if (rsi >= 35 && rsi <= 65) score += 10;
    else if (rsi >= 30 && rsi <= 70) score += 5;
  }

  // Technical signal bullish (0-20)
  // technicalSignal is 'bullish' | 'bearish' | 'neutral' in TechnicalIndicators
  const sig = technicals?.technicalSignal;
  if (sig === 'bullish') score += 20;
  else if (sig === 'neutral') score += 8;

  // Multi-screen hits (0-15)
  if (finvizHits >= 3) score += 15;
  else if (finvizHits === 2) score += 10;
  else if (finvizHits === 1) score += 4;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Risk score (0-100, HIGHER = WORSE).
 * Items that are also hard gates (micro-cap, no analyst, sub-$2) are NOT
 * scored here — they block entry in tradeability.ts before this runs.
 */
export function calculateRiskScoreV2(input: UnifiedScoringInputs): number {
  const { fundamentals, yahoo } = input;
  let score = 15; // base

  // Debt/equity high
  const de = fundamentals.debtEquity;
  if (typeof de === 'number') {
    if (de > 2.0) score += 25;
    else if (de > 1.0) score += 12;
  }

  // Negative or zero revenue growth
  const rg = fundamentals.revenueGrowth;
  if (typeof rg === 'number') {
    if (rg < -0.10) score += 20;
    else if (rg <= 0) score += 10;
  }

  // Small cap ($300M-$2B) → moderate penalty
  const mc = fundamentals.marketCap;
  if (typeof mc === 'number' && mc < 2_000_000_000 && mc >= 300_000_000) {
    score += 15;
  }

  // Negative operating margin
  const om = fundamentals.operatingMargin;
  if (typeof om === 'number' && om < 0) {
    score += 15;
  }

  // Mild analyst coverage (passed gate but thin)
  const analysts = yahoo?.numberOfAnalystOpinions ?? 0;
  if (analysts < 5) score += 10;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Attention score (tie-breaker only, NOT part of composite)
 */
export function calculateAttentionScoreV2(sentiment: MergedSentiment): number {
  const src = sentiment.sources;
  const apeRank = src['apewisdom-penny']?.rank
    ?? src['apewisdom-all']?.rank
    ?? src['apewisdom-wsb']?.rank
    ?? 999;
  const stMentions = src.stocktwits?.mentions ?? 0;
  const finvizHits = [src.finviz].filter(Boolean).length;

  let score = 0;
  if (apeRank <= 10) score += 40;
  else if (apeRank <= 50) score += 25;
  else if (apeRank <= 100) score += 10;
  if (stMentions > 1000) score += 20;
  else if (stMentions > 100) score += 10;
  score += finvizHits * 10;
  return Math.min(100, score);
}

/**
 * Composite score with weights from spec:
 * composite = 0.30*value + 0.35*catalyst + 0.25*upside - 0.15*risk
 * Attention is NOT included.
 */
export function calculateCompositeScore(
  value: number,
  catalyst: number,
  upside: number,
  risk: number
): number {
  const composite = 0.30 * value + 0.35 * catalyst + 0.25 * upside - 0.15 * risk;
  return Math.round(composite);
}

/**
 * Build the full ComponentScores object from unified inputs.
 */
export function calculateAllUnifiedScores(input: UnifiedScoringInputs): ComponentScores {
  const value = calculateValueScore(input);
  const catalyst = calculateCatalystScoreV2(input);
  const upside = calculateUpsideScore(input);
  const risk = calculateRiskScoreV2(input);
  const attention = calculateAttentionScoreV2(input.sentiment);
  const composite = calculateCompositeScore(value, catalyst, upside, risk);
  return { value, catalyst, upside, risk, attention, composite };
}

/**
 * Classification based on composite + risk + tradeability.
 */
export function classifyUnified(
  scores: ComponentScores,
  tradeable: boolean
): 'BUY' | 'WATCH' | 'AVOID' {
  if (scores.composite < 35 || scores.risk > 60) return 'AVOID';
  if (scores.composite >= 55 && scores.risk <= 45 && tradeable) return 'BUY';
  return 'WATCH';
}

export type { UnifiedScoringInputs };
