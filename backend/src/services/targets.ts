/**
 * Target Price Calculator
 * Calculates buy/sell targets using 4 methods:
 * 1. Technical - support/resistance, 52-week levels
 * 2. Fundamental - fair value from ratios
 * 3. AI - Claude-generated targets
 * 4. Risk-based - percentage-based targets
 */

import type { PriceData, FundamentalData, MergedSentiment, Scores } from '../types/index.js';

export interface TargetPrices {
  technical: number;
  fundamental: number;
  ai: number;
  risk: number;
  average: number;
  stopLoss: number;
  details: TargetDetails;
}

export interface TargetDetails {
  technical: {
    method: string;
    resistance: number;
    support: number;
    high52w: number;
    low52w: number;
    target: number;
    confidence: number;
  };
  fundamental: {
    method: string;
    currentPE: number | null;
    sectorAvgPE: number;
    fairValue: number;
    target: number;
    confidence: number;
  };
  ai: {
    method: string;
    target: number;
    reasoning: string;
    confidence: number;
  };
  risk: {
    method: string;
    entryPrice: number;
    target10pct: number;
    target20pct: number;
    stopLoss: number;
    target: number;
    confidence: number;
  };
}

// Sector average P/E ratios (approximate)
const SECTOR_PE: Record<string, number> = {
  'Technology': 25,
  'Healthcare': 20,
  'Financial Services': 12,
  'Consumer Cyclical': 18,
  'Consumer Defensive': 22,
  'Industrials': 18,
  'Energy': 10,
  'Basic Materials': 12,
  'Real Estate': 35,
  'Utilities': 18,
  'Communication Services': 20,
  'default': 15,
};

/**
 * Calculate technical target price
 * Uses 52-week range, current price position, and momentum
 */
function calculateTechnicalTarget(price: PriceData): TargetDetails['technical'] {
  const currentPrice = price.price;
  const high52w = price.high52w || currentPrice * 1.3;
  const low52w = price.low52w || currentPrice * 0.7;
  const range = high52w - low52w;

  // Calculate where current price sits in the 52-week range
  const positionInRange = (currentPrice - low52w) / range;

  // Support and resistance estimates
  const support = low52w + range * 0.25;
  const resistance = low52w + range * 0.75;

  // Target calculation based on position
  let target: number;
  let confidence: number;

  if (positionInRange < 0.3) {
    // Near 52-week low - bullish target to mid-range
    target = low52w + range * 0.5;
    confidence = 0.7;
  } else if (positionInRange < 0.5) {
    // Lower half - target resistance
    target = resistance;
    confidence = 0.65;
  } else if (positionInRange < 0.7) {
    // Middle - target 52-week high
    target = high52w * 0.95;
    confidence = 0.5;
  } else {
    // Near highs - limited upside, target slight gain
    target = currentPrice * 1.1;
    confidence = 0.4;
  }

  // Adjust for momentum
  if (price.change5dPercent > 10) {
    target *= 1.05; // Strong momentum, raise target
  } else if (price.change5dPercent < -10) {
    target *= 0.95; // Weak momentum, lower target
  }

  return {
    method: '52-Week Range Analysis',
    resistance: Math.round(resistance * 100) / 100,
    support: Math.round(support * 100) / 100,
    high52w: Math.round(high52w * 100) / 100,
    low52w: Math.round(low52w * 100) / 100,
    target: Math.round(target * 100) / 100,
    confidence,
  };
}

/**
 * Calculate fundamental target price
 * Based on P/E ratio compared to sector average
 */
function calculateFundamentalTarget(
  price: PriceData,
  fundamentals: FundamentalData
): TargetDetails['fundamental'] {
  const currentPrice = price.price;
  const currentPE = fundamentals.peRatio;
  const sector = fundamentals.sector || 'default';
  const sectorAvgPE = SECTOR_PE[sector] || SECTOR_PE['default'];

  let target: number;
  let confidence: number;
  let fairValue: number;

  if (currentPE && currentPE > 0) {
    // Calculate EPS from current price and P/E
    const eps = currentPrice / currentPE;
    fairValue = eps * sectorAvgPE;

    // Adjust for growth
    if (fundamentals.revenueGrowth && fundamentals.revenueGrowth > 20) {
      fairValue *= 1.2; // Premium for high growth
    } else if (fundamentals.revenueGrowth && fundamentals.revenueGrowth < 0) {
      fairValue *= 0.85; // Discount for declining revenue
    }

    // Target is weighted between fair value and current price
    target = (fairValue * 0.7 + currentPrice * 0.3);
    confidence = 0.6;
  } else {
    // No P/E available - use P/S or simple estimate
    if (fundamentals.psRatio && fundamentals.psRatio > 0) {
      // Industry average P/S is roughly 2-3 for most sectors
      const targetPS = 2.5;
      const revenuePerShare = currentPrice / fundamentals.psRatio;
      fairValue = revenuePerShare * targetPS;
      target = (fairValue * 0.6 + currentPrice * 0.4);
      confidence = 0.4;
    } else {
      // Fallback - modest upside
      fairValue = currentPrice * 1.15;
      target = fairValue;
      confidence = 0.3;
    }
  }

  return {
    method: 'P/E Fair Value Analysis',
    currentPE,
    sectorAvgPE,
    fairValue: Math.round(fairValue * 100) / 100,
    target: Math.round(target * 100) / 100,
    confidence,
  };
}

/**
 * Calculate risk-based target price
 * Simple percentage-based targets
 */
function calculateRiskTarget(price: PriceData, scores: Scores): TargetDetails['risk'] {
  const currentPrice = price.price;
  const riskScore = scores.risk;

  // Adjust target percentages based on risk
  let targetPct: number;
  let stopPct: number;

  if (riskScore < 30) {
    // Low risk - higher targets
    targetPct = 0.25;
    stopPct = 0.08;
  } else if (riskScore < 50) {
    // Moderate risk
    targetPct = 0.20;
    stopPct = 0.10;
  } else if (riskScore < 70) {
    // Higher risk
    targetPct = 0.15;
    stopPct = 0.12;
  } else {
    // High risk - tighter stops
    targetPct = 0.10;
    stopPct = 0.15;
  }

  const target10pct = currentPrice * 1.10;
  const target20pct = currentPrice * (1 + targetPct);
  const stopLoss = currentPrice * (1 - stopPct);

  return {
    method: 'Risk-Adjusted Targets',
    entryPrice: Math.round(currentPrice * 100) / 100,
    target10pct: Math.round(target10pct * 100) / 100,
    target20pct: Math.round(target20pct * 100) / 100,
    stopLoss: Math.round(stopLoss * 100) / 100,
    target: Math.round(target20pct * 100) / 100,
    confidence: 0.7,
  };
}

/**
 * Calculate AI target price (placeholder - will be filled by classifier)
 */
function calculateAITarget(
  price: PriceData,
  technicalTarget: number,
  fundamentalTarget: number,
  riskTarget: number
): TargetDetails['ai'] {
  // Default AI target is weighted average of other methods
  // This will be overwritten by actual AI analysis in the classifier
  const avgTarget = (technicalTarget + fundamentalTarget + riskTarget) / 3;

  return {
    method: 'AI Analysis',
    target: Math.round(avgTarget * 100) / 100,
    reasoning: 'Weighted average of technical, fundamental, and risk analysis',
    confidence: 0.5,
  };
}

/**
 * Main function to calculate all target prices
 */
export function calculateTargetPrices(
  price: PriceData,
  fundamentals: FundamentalData,
  scores: Scores,
  aiTarget?: { target: number; reasoning: string; confidence: number }
): TargetPrices {
  const technical = calculateTechnicalTarget(price);
  const fundamental = calculateFundamentalTarget(price, fundamentals);
  const risk = calculateRiskTarget(price, scores);

  // AI target - use provided or calculate default
  const ai = aiTarget
    ? {
        method: 'AI Analysis',
        target: aiTarget.target,
        reasoning: aiTarget.reasoning,
        confidence: aiTarget.confidence,
      }
    : calculateAITarget(price, technical.target, fundamental.target, risk.target);

  // Calculate weighted average (weight by confidence)
  const totalConfidence = technical.confidence + fundamental.confidence + ai.confidence + risk.confidence;
  const weightedAvg =
    (technical.target * technical.confidence +
      fundamental.target * fundamental.confidence +
      ai.target * ai.confidence +
      risk.target * risk.confidence) /
    totalConfidence;

  // Stop loss is the most conservative (lowest)
  const stopLoss = Math.min(risk.stopLoss, price.price * 0.9);

  return {
    technical: technical.target,
    fundamental: fundamental.target,
    ai: ai.target,
    risk: risk.target,
    average: Math.round(weightedAvg * 100) / 100,
    stopLoss: Math.round(stopLoss * 100) / 100,
    details: {
      technical,
      fundamental,
      ai,
      risk,
    },
  };
}

export default {
  calculateTargetPrices,
};
