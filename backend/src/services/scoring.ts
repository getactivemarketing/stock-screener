import type {
  MergedSentiment,
  PriceData,
  FundamentalData,
  Scores,
  Classification,
  ClassificationResult,
} from '../types/index.js';
import { alertConfig } from '../lib/config.js';

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

  // Rank bonus from ApeWisdom (0-20 points)
  let rankScore = 0;
  if (sources.apewisdom?.rank) {
    const rank = sources.apewisdom.rank;
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

/**
 * Calculate fundamentals score (0-100) based on company metrics
 */
export function calculateFundamentalsScore(fundamentals: FundamentalData): number {
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
  fundamentals: FundamentalData
): Scores {
  const attention = calculateAttentionScore(sentiment);
  const momentum = calculateMomentumScore(price);
  const fundamentalsScore = calculateFundamentalsScore(fundamentals);
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
