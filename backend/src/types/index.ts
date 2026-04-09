// Sentiment data from aggregators
export interface SentimentData {
  ticker: string;
  source: 'swaggy' | 'apewisdom-all' | 'apewisdom-penny' | 'apewisdom-wsb' | 'altindex' | 'stocktwits' | 'finviz';
  mentions: number;
  sentiment: number; // -100 to 100
  momentum?: number; // ratio vs previous period
  rank?: number;
  timestamp?: Date;
}

// Normalized sentiment per ticker (merged from all sources)
export interface MergedSentiment {
  ticker: string;
  totalMentions: number;
  avgSentiment: number;
  maxMomentum: number;
  sourceCount: number;
  isPennyStock?: boolean; // Flag for penny stock prioritization
  sources: {
    swaggy?: SentimentData;
    'apewisdom-all'?: SentimentData;
    'apewisdom-penny'?: SentimentData;
    'apewisdom-wsb'?: SentimentData;
    altindex?: SentimentData;
    stocktwits?: SentimentData;
    finviz?: SentimentData;
  };
}

// Price and volume data
export interface PriceData {
  ticker: string;
  price: number;
  change1d: number;
  change1dPercent: number;
  change5d: number;
  change5dPercent: number;
  change30d: number;
  change30dPercent: number;
  volume: number;
  avgVolume30d: number;
  relativeVolume: number;
  high52w: number;
  low52w: number;
  timestamp: Date;
}

// Fundamental data
export interface FundamentalData {
  ticker: string;
  name: string;
  sector: string;
  industry: string;
  exchange: string;
  country: string;
  marketCap: number;
  sharesOutstanding: number;
  peRatio: number | null;
  psRatio: number | null;
  pbRatio: number | null;
  epsGrowth: number | null;
  revenueGrowth: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  debtEquity: number | null;
  recentFilings: number;
  timestamp: Date;
}

// Computed scores
export interface Scores {
  attention: number; // 0-100
  momentum: number; // 0-100
  fundamentals: number; // 0-100
  risk: number; // 0-100 (higher = more risky)
}

// Classification from Claude
export type Classification = 'runner' | 'value' | 'both' | 'avoid' | 'watch';

export interface ClassificationResult {
  classification: Classification;
  confidence: number;
  bullCase: string;
  bearCase: string;
  catalysts: string[];
}

// Complete ticker analysis
export interface TickerAnalysis {
  ticker: string;
  runId: string;
  runTimestamp: Date;
  tier: Tier;                              // NEW - add this
  sentiment: MergedSentiment;
  price: PriceData;
  fundamentals: FundamentalData;
  scores: Scores;
  classification: ClassificationResult;
  enrichment?: ClassifierEnrichment;       // NEW - add this
  alertTriggered: boolean;
  alertType: 'runner' | 'value' | 'both' | 'pump_warning' | null;
}

// Alert configuration
export interface AlertConfig {
  runner: {
    minAttention: number;
    minMomentum: number;
    maxRisk: number;
  };
  value: {
    minFundamentals: number;
    minMomentum: number;
    maxMomentum: number;
    maxRisk: number;
  };
  pumpWarning: {
    minRisk: number;
  };
}

// API response types
export interface SwaggyResponse {
  ticker: string;
  sentiment: number;
  mentions: number;
  bullish: number;
  bearish: number;
  momentum?: number;
}

export interface ApeWisdomResponse {
  ticker: string;
  name: string;
  rank: number;
  mentions: number;
  upvotes: number;
  rank_24h_ago?: number;
}

export interface AltIndexResponse {
  ticker: string;
  social_score: number;
  reddit_mentions: number;
  sentiment_score: number;
}

export interface AlphaVantageOverview {
  Symbol: string;
  Name: string;
  Exchange: string;
  Country: string;
  Sector: string;
  Industry: string;
  MarketCapitalization: string;
  PERatio: string;
  PriceToSalesRatioTTM: string;
  PriceToBookRatio: string;
  EPS: string;
  RevenuePerShareTTM: string;
  ProfitMargin: string;
  OperatingMarginTTM: string;
  GrossProfitTTM: string;
  QuarterlyEarningsGrowthYOY: string;
  QuarterlyRevenueGrowthYOY: string;
  SharesOutstanding: string;
  '52WeekHigh': string;
  '52WeekLow': string;
}

export interface FinnhubQuote {
  c: number; // current price
  d: number; // change
  dp: number; // percent change
  h: number; // high
  l: number; // low
  o: number; // open
  pc: number; // previous close
  t: number; // timestamp
}

export interface FinnhubProfile {
  country: string;
  currency: string;
  exchange: string;
  ipo: string;
  marketCapitalization: number;
  name: string;
  phone: string;
  shareOutstanding: number;
  ticker: string;
  weburl: string;
  logo: string;
  finnhubIndustry: string;
}

// Technical indicators
export interface TechnicalIndicators {
  ticker: string;
  // RSI
  rsi14: number | null;
  rsiSignal: 'oversold' | 'overbought' | 'neutral';
  // MACD
  macdValue: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  macdCrossover: 'bullish' | 'bearish' | 'none';
  // Bollinger Bands
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  bbPosition: 'above' | 'below' | 'inside';
  // Moving Averages
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema20: number | null;
  maTrend: 'bullish' | 'bearish' | 'neutral';
  // OBV
  obvTrend: 'accumulation' | 'distribution' | 'neutral';
  // Overall signal
  technicalSignal: 'bullish' | 'bearish' | 'neutral';
  signalStrength: number; // 0-100
}

// ── Trading Types ──────────────────────────────────────

export interface TradingConfig {
  enabled: boolean;
  maxPositions: number;
  maxPositionPct: number;
  maxPortfolioHeatPct: number;
  minFundamentals: number;
  maxRisk: number;
  minMomentum: number;
  holdDaysMax: number;
  highConvictionSizePct: number;
  highConvictionMinScores: number;
  highConvictionMaxRisk: number;
  dailyLossLimitPct: number;
  scanMissMax: number;
  slippagePct: number;
  qualityHoldDaysMax: number;
}

export interface TradeDecision {
  ticker: string;
  action: 'BUY' | 'SELL' | 'HOLD' | 'SKIP';
  reason: string;
  quantity?: number;
  positionSizePct?: number;
  classification: string;
  scores: Scores;
  tradeRationale?: string;
  keyRisk?: string;
  stopLoss?: number;
  targetPrice?: number;
  scanResultId?: string;
  configSnapshot?: TradingConfig;
}

export interface AlpacaAccount {
  id: string;
  equity: number;
  cash: number;
  buyingPower: number;
  portfolioValue: number;
  dayPl: number;
  dayPlPct: number;
}

export interface AlpacaPosition {
  ticker: string;
  quantity: number;
  avgEntryPrice: number;
  marketValue: number;
  currentPrice: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
  side: string;
}

export interface AlpacaOrder {
  id: string;
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  type: string;
  status: string;
  filledAvgPrice: number | null;
  filledAt: string | null;
  createdAt: string;
}

export interface RiskCheckResult {
  approved: boolean;
  adjustedQuantity?: number;
  reason?: string;
}

// Extended classification result with trade-enriched fields
export interface EnrichedClassificationResult extends ClassificationResult {
  tradeRationale?: string;
  suggestedPositionPct?: number;
  keyRisk?: string;
}

// ── Dual-Tier Types ────────────────────────────────────

export type Tier = 'MOMENTUM' | 'QUALITY';

export interface ClassifierEnrichment {
  analystRatings: {
    summary: string;
    meanTarget: number | null;
    highTarget: number | null;
    lowTarget: number | null;
  } | null;
  earnings: {
    nextDate: string | null;
    daysToEarnings: number | null;
    epsEstimate: number | null;
    earningsBeatRate: number | null;
  } | null;
  newsHeadlines: string[] | null;
}

export interface DualTierClassificationResult {
  classification: Classification;
  tier: Tier;
  confidence: number;
  valueScore: number;
  catalystScore: number;
  emergingIndustryScore: number;
  thesis: string;
  edgeWhyNow: string;
  bullCase: string;
  bearCase: string;
  keyRisk: string;
  catalysts: string[];
  industryTheme: string | null;
  tradeRationale: string;
  suggestedPositionPct: number;
  targetPrice: {
    target: number;
    reasoning: string;
    confidence: number;
  };
  stopLossPct: number;
  expectedReturns: {
    oneMonth: string;
    threeMonth: string;
    twelveMonth: string;
  };
}

// ── Unified Screener Types (2026-04-08) ────────────────

export type EntryCategory =
  | 'earnings_event'
  | 'insider_signal'
  | 'value_rerating'
  | 'attention_momentum';

export interface ComponentScores {
  value: number;      // 0-100
  catalyst: number;   // 0-100
  upside: number;     // 0-100
  risk: number;       // 0-100 (higher = worse)
  attention: number;  // 0-100 (tie-breaker only)
  composite: number;  // ~-15 to 90
}

export interface TradeabilityResult {
  tradeable: boolean;
  failures: string[]; // e.g., ['price_lt_2', 'no_analyst_coverage']
}

export interface YahooQuoteSummary {
  ticker: string;
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  numberOfAnalystOpinions: number;
  recommendationMean: number | null; // 1=Strong Buy, 5=Strong Sell
  trailingPE: number | null;
  forwardPE: number | null;
  priceToBook: number | null;
  priceToSales: number | null;
  high52w: number | null;
  low52w: number | null;
}

export interface UnifiedClassification {
  thesis: string;
  valueCase: string;
  catalysts: Array<{ description: string; date: string | null }>;
  keyRisks: string[];
  expectedReturn30d: number;
  convictionScore: number; // 0-10
  recommendation: 'BUY' | 'WATCH' | 'AVOID';
}

export interface EntryAttribution {
  valueScore: number;
  catalystScore: number;
  upsideScore: number;
  riskScore: number;
  composite: number;
  category: EntryCategory;
  catalystType: string;
  catalystDate: string | null; // YYYY-MM-DD
}

export interface ExitAttribution {
  valueScore: number;
  catalystScore: number;
  upsideScore: number;
  riskScore: number;
  composite: number;
  reason: 'stop_loss' | 'catalyst_fade' | 'max_hold' | 'reclass_avoid' | 'scan_miss' | 'manual';
}
