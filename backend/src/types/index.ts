// Sentiment data from aggregators
export interface SentimentData {
  ticker: string;
  source: 'swaggy' | 'apewisdom' | 'altindex' | 'stocktwits' | 'finviz' | 'reddit-penny';
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
    apewisdom?: SentimentData;
    altindex?: SentimentData;
    stocktwits?: SentimentData;
    finviz?: SentimentData;
    'reddit-penny'?: SentimentData;
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
  sentiment: MergedSentiment;
  price: PriceData;
  fundamentals: FundamentalData;
  scores: Scores;
  classification: ClassificationResult;
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
