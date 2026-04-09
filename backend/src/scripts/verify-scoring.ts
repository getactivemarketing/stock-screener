import {
  calculateValueScore,
  calculateCatalystScoreV2,
  calculateUpsideScore,
  calculateRiskScoreV2,
  calculateCompositeScore,
  calculateAllUnifiedScores,
  classifyUnified,
} from '../services/scoring.js';
import type { PriceData, FundamentalData, MergedSentiment, YahooQuoteSummary, ClassifierEnrichment } from '../types/index.js';

const goodPrice: PriceData = {
  ticker: 'TEST',
  price: 40,
  change1d: 0, change1dPercent: 0,
  change5d: 0, change5dPercent: 0,
  change30d: 5, change30dPercent: 12,
  volume: 2_000_000,
  avgVolume30d: 1_500_000,
  relativeVolume: 1.8,
  high52w: 70, low52w: 35,
  timestamp: new Date(),
};
const goodFund: FundamentalData = {
  ticker: 'TEST', name: 'Test Co', sector: 'Technology', industry: 'Software',
  exchange: 'NASDAQ', country: 'US', marketCap: 5_000_000_000, sharesOutstanding: 125_000_000,
  peRatio: 15, psRatio: 2.5, pbRatio: 2.5,
  epsGrowth: null, revenueGrowth: 0.15, grossMargin: 0.55, operatingMargin: 0.18,
  debtEquity: 0.5, recentFilings: 0, timestamp: new Date(),
};
const goodYahoo: YahooQuoteSummary = {
  ticker: 'TEST', targetMeanPrice: 60, targetHighPrice: 70, targetLowPrice: 50,
  numberOfAnalystOpinions: 8, recommendationMean: 2.0,
  trailingPE: 15, forwardPE: 13, priceToBook: 2.5, priceToSales: 2.5,
  high52w: 70, low52w: 35,
};
// ClassifierEnrichment does not yet have insiderActivity (added in task C2) — cast as any
const goodEnrich = {
  analystRatings: { summary: 'Strong Buy: 4, Buy: 3, Hold: 1', meanTarget: 60, highTarget: 70, lowTarget: 50 },
  earnings: { nextDate: '2026-04-15', daysToEarnings: 7, epsEstimate: 1.2, earningsBeatRate: 75 },
  newsHeadlines: ['h1', 'h2', 'h3'],
  insiderActivity: null,
} as any as ClassifierEnrichment;
const goodSentiment: MergedSentiment = {
  ticker: 'TEST', totalMentions: 50, avgSentiment: 60, maxMomentum: 1.5,
  sourceCount: 3, sources: {},
};

const goodInput = {
  sentiment: goodSentiment, price: goodPrice, fundamentals: goodFund,
  yahoo: goodYahoo, enrichment: goodEnrich, technicals: null,
  finvizHits: 2, insiderLargeBuy90d: true, insiderAnyBuy90d: true, insiderNetSelling: false,
};

const good = calculateAllUnifiedScores(goodInput);
console.log('GOOD candidate:', good);
console.assert(good.value >= 60, `good value should be ≥60, got ${good.value}`);
console.assert(good.catalyst >= 60, `good catalyst should be ≥60, got ${good.catalyst}`);
console.assert(good.composite >= 55, `good composite should be ≥55, got ${good.composite}`);
console.assert(classifyUnified(good, true) === 'BUY', `should classify as BUY`);

const junkInput = {
  ...goodInput,
  price: { ...goodPrice, price: 8, high52w: 8, change30dPercent: -15, relativeVolume: 0.5 },
  fundamentals: { ...goodFund, marketCap: 400_000_000, revenueGrowth: -0.10, grossMargin: 0.10, operatingMargin: -0.05, peRatio: 50, pbRatio: 10, debtEquity: 3.0 },
  yahoo: { ...goodYahoo, targetMeanPrice: 7, numberOfAnalystOpinions: 2 },
  enrichment: { ...goodEnrich, earnings: { nextDate: null, daysToEarnings: null, epsEstimate: null, earningsBeatRate: 0 } },
  insiderLargeBuy90d: false, insiderAnyBuy90d: false, insiderNetSelling: true,
  finvizHits: 0,
};
const junk = calculateAllUnifiedScores(junkInput);
console.log('JUNK candidate:', junk);
console.assert(junk.composite < 40, `junk composite should be <40, got ${junk.composite}`);
console.assert(classifyUnified(junk, true) === 'AVOID', `should classify as AVOID`);

console.log('verify-scoring: OK');
