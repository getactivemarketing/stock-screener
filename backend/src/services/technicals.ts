import { RSI, MACD, BollingerBands, SMA, EMA, OBV } from 'technicalindicators';
import { fetchCandles } from './finnhub.js';
import { fetchDailyTimeSeries } from './alphavantage.js';

export interface CandleData {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  timestamps: number[];
}

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

/**
 * Fetch candle data from Finnhub, with Alpha Vantage fallback
 * Default: 60 days of daily candles
 */
export async function fetchCandleData(
  ticker: string,
  daysBack: number = 60
): Promise<CandleData | null> {
  // Try Finnhub first
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - daysBack * 24 * 60 * 60;

    const candles = await fetchCandles(ticker, 'D', from, now);

    if (candles && candles.s === 'ok' && candles.c && candles.c.length >= 14) {
      return {
        open: candles.o,
        high: candles.h,
        low: candles.l,
        close: candles.c,
        volume: candles.v,
        timestamps: candles.t,
      };
    }
  } catch (err) {
    console.log(`Finnhub candles unavailable for ${ticker}, trying Alpha Vantage...`);
  }

  // Fallback to Alpha Vantage
  console.log(`Trying Alpha Vantage fallback for ${ticker}...`);
  try {
    const timeSeries = await fetchDailyTimeSeries(ticker, 'compact');
    console.log(`Alpha Vantage returned ${timeSeries.length} candles for ${ticker}`);

    if (timeSeries.length >= 14) {
      // Alpha Vantage returns newest first, reverse for chronological order
      const sorted = [...timeSeries].reverse();

      console.log(`Using Alpha Vantage data for ${ticker} technical analysis`);
      return {
        open: sorted.map(d => d.open),
        high: sorted.map(d => d.high),
        low: sorted.map(d => d.low),
        close: sorted.map(d => d.close),
        volume: sorted.map(d => d.volume),
        timestamps: sorted.map(d => new Date(d.date).getTime() / 1000),
      };
    }
  } catch (err) {
    console.error(`Alpha Vantage candles also failed for ${ticker}:`, err);
  }

  console.warn(`No candle data available for ${ticker}`);
  return null;
}

/**
 * Calculate RSI (Relative Strength Index)
 */
function calculateRSI(close: number[], period: number = 14): { value: number | null; signal: 'oversold' | 'overbought' | 'neutral' } {
  if (close.length < period + 1) {
    return { value: null, signal: 'neutral' };
  }

  const rsiValues = RSI.calculate({
    values: close,
    period,
  });

  const latestRSI = rsiValues[rsiValues.length - 1];

  if (latestRSI === undefined) {
    return { value: null, signal: 'neutral' };
  }

  let signal: 'oversold' | 'overbought' | 'neutral' = 'neutral';
  if (latestRSI < 30) signal = 'oversold';
  else if (latestRSI > 70) signal = 'overbought';

  return { value: Math.round(latestRSI * 100) / 100, signal };
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 */
function calculateMACD(
  close: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): {
  value: number | null;
  signal: number | null;
  histogram: number | null;
  crossover: 'bullish' | 'bearish' | 'none';
} {
  if (close.length < slowPeriod + signalPeriod) {
    return { value: null, signal: null, histogram: null, crossover: 'none' };
  }

  const macdResults = MACD.calculate({
    values: close,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  if (macdResults.length < 2) {
    return { value: null, signal: null, histogram: null, crossover: 'none' };
  }

  const latest = macdResults[macdResults.length - 1];
  const previous = macdResults[macdResults.length - 2];

  if (!latest.MACD || !latest.signal || !latest.histogram) {
    return { value: null, signal: null, histogram: null, crossover: 'none' };
  }

  // Detect crossover
  let crossover: 'bullish' | 'bearish' | 'none' = 'none';
  if (previous.MACD !== undefined && previous.signal !== undefined) {
    const wasBelow = previous.MACD < previous.signal;
    const isAbove = latest.MACD > latest.signal;
    const wasAbove = previous.MACD > previous.signal;
    const isBelow = latest.MACD < latest.signal;

    if (wasBelow && isAbove) crossover = 'bullish';
    else if (wasAbove && isBelow) crossover = 'bearish';
  }

  return {
    value: Math.round(latest.MACD * 10000) / 10000,
    signal: Math.round(latest.signal * 10000) / 10000,
    histogram: Math.round(latest.histogram * 10000) / 10000,
    crossover,
  };
}

/**
 * Calculate Bollinger Bands
 */
function calculateBollingerBands(
  close: number[],
  period: number = 20,
  stdDev: number = 2
): {
  upper: number | null;
  middle: number | null;
  lower: number | null;
  position: 'above' | 'below' | 'inside';
} {
  if (close.length < period) {
    return { upper: null, middle: null, lower: null, position: 'inside' };
  }

  const bbResults = BollingerBands.calculate({
    values: close,
    period,
    stdDev,
  });

  if (bbResults.length === 0) {
    return { upper: null, middle: null, lower: null, position: 'inside' };
  }

  const latest = bbResults[bbResults.length - 1];
  const currentPrice = close[close.length - 1];

  let position: 'above' | 'below' | 'inside' = 'inside';
  if (currentPrice > latest.upper) position = 'above';
  else if (currentPrice < latest.lower) position = 'below';

  return {
    upper: Math.round(latest.upper * 10000) / 10000,
    middle: Math.round(latest.middle * 10000) / 10000,
    lower: Math.round(latest.lower * 10000) / 10000,
    position,
  };
}

/**
 * Calculate Simple Moving Averages
 */
function calculateSMAs(close: number[]): {
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
} {
  const sma20Values = close.length >= 20 ? SMA.calculate({ values: close, period: 20 }) : [];
  const sma50Values = close.length >= 50 ? SMA.calculate({ values: close, period: 50 }) : [];
  const sma200Values = close.length >= 200 ? SMA.calculate({ values: close, period: 200 }) : [];

  return {
    sma20: sma20Values.length > 0 ? Math.round(sma20Values[sma20Values.length - 1] * 10000) / 10000 : null,
    sma50: sma50Values.length > 0 ? Math.round(sma50Values[sma50Values.length - 1] * 10000) / 10000 : null,
    sma200: sma200Values.length > 0 ? Math.round(sma200Values[sma200Values.length - 1] * 10000) / 10000 : null,
  };
}

/**
 * Calculate Exponential Moving Average
 */
function calculateEMA(close: number[], period: number = 20): number | null {
  if (close.length < period) return null;

  const emaValues = EMA.calculate({ values: close, period });

  return emaValues.length > 0 ? Math.round(emaValues[emaValues.length - 1] * 10000) / 10000 : null;
}

/**
 * Determine MA trend (golden/death cross potential)
 */
function determineMATrend(
  currentPrice: number,
  sma20: number | null,
  sma50: number | null,
  ema20: number | null
): 'bullish' | 'bearish' | 'neutral' {
  let bullishSignals = 0;
  let bearishSignals = 0;

  // Price above/below moving averages
  if (sma20 !== null) {
    if (currentPrice > sma20) bullishSignals++;
    else bearishSignals++;
  }

  if (sma50 !== null) {
    if (currentPrice > sma50) bullishSignals++;
    else bearishSignals++;
  }

  // EMA20 vs SMA20 (momentum)
  if (ema20 !== null && sma20 !== null) {
    if (ema20 > sma20) bullishSignals++;
    else bearishSignals++;
  }

  // SMA20 vs SMA50 (trend)
  if (sma20 !== null && sma50 !== null) {
    if (sma20 > sma50) bullishSignals++;
    else bearishSignals++;
  }

  if (bullishSignals >= 3) return 'bullish';
  if (bearishSignals >= 3) return 'bearish';
  return 'neutral';
}

/**
 * Calculate OBV trend (On-Balance Volume)
 */
function calculateOBVTrend(
  close: number[],
  volume: number[]
): 'accumulation' | 'distribution' | 'neutral' {
  if (close.length < 14 || volume.length < 14) {
    return 'neutral';
  }

  const obvValues = OBV.calculate({ close, volume });

  if (obvValues.length < 14) {
    return 'neutral';
  }

  // Compare recent OBV to earlier OBV
  const recentOBV = obvValues.slice(-5);
  const earlierOBV = obvValues.slice(-14, -5);

  const recentAvg = recentOBV.reduce((a, b) => a + b, 0) / recentOBV.length;
  const earlierAvg = earlierOBV.reduce((a, b) => a + b, 0) / earlierOBV.length;

  const change = (recentAvg - earlierAvg) / Math.abs(earlierAvg || 1);

  if (change > 0.05) return 'accumulation';
  if (change < -0.05) return 'distribution';
  return 'neutral';
}

/**
 * Calculate overall technical signal and strength
 */
function calculateOverallSignal(indicators: {
  rsiSignal: 'oversold' | 'overbought' | 'neutral';
  macdCrossover: 'bullish' | 'bearish' | 'none';
  macdHistogram: number | null;
  bbPosition: 'above' | 'below' | 'inside';
  maTrend: 'bullish' | 'bearish' | 'neutral';
  obvTrend: 'accumulation' | 'distribution' | 'neutral';
}): { signal: 'bullish' | 'bearish' | 'neutral'; strength: number } {
  let bullishPoints = 0;
  let bearishPoints = 0;
  let totalPoints = 0;

  // RSI (weight: 2)
  totalPoints += 2;
  if (indicators.rsiSignal === 'oversold') bullishPoints += 2; // Oversold = potential buy
  else if (indicators.rsiSignal === 'overbought') bearishPoints += 2;

  // MACD crossover (weight: 3)
  totalPoints += 3;
  if (indicators.macdCrossover === 'bullish') bullishPoints += 3;
  else if (indicators.macdCrossover === 'bearish') bearishPoints += 3;

  // MACD histogram direction (weight: 1)
  totalPoints += 1;
  if (indicators.macdHistogram !== null) {
    if (indicators.macdHistogram > 0) bullishPoints += 1;
    else if (indicators.macdHistogram < 0) bearishPoints += 1;
  }

  // Bollinger Bands (weight: 2)
  totalPoints += 2;
  if (indicators.bbPosition === 'below') bullishPoints += 2; // Near lower band = potential bounce
  else if (indicators.bbPosition === 'above') bearishPoints += 2;

  // MA Trend (weight: 2)
  totalPoints += 2;
  if (indicators.maTrend === 'bullish') bullishPoints += 2;
  else if (indicators.maTrend === 'bearish') bearishPoints += 2;

  // OBV Trend (weight: 1)
  totalPoints += 1;
  if (indicators.obvTrend === 'accumulation') bullishPoints += 1;
  else if (indicators.obvTrend === 'distribution') bearishPoints += 1;

  // Calculate strength (0-100)
  const netPoints = bullishPoints - bearishPoints;
  const maxNet = totalPoints;
  const strength = Math.round(((netPoints + maxNet) / (2 * maxNet)) * 100);

  // Determine signal
  let signal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (bullishPoints >= bearishPoints + 3) signal = 'bullish';
  else if (bearishPoints >= bullishPoints + 3) signal = 'bearish';

  return { signal, strength };
}

/**
 * Calculate all technical indicators for a ticker
 */
export async function calculateTechnicalIndicators(
  ticker: string,
  candleData?: CandleData | null
): Promise<TechnicalIndicators | null> {
  // Fetch candle data if not provided
  const data = candleData ?? await fetchCandleData(ticker, 200); // Get 200 days for SMA200

  if (!data) {
    console.warn(`No candle data available for ${ticker}`);
    return null;
  }

  const { close, volume } = data;
  const currentPrice = close[close.length - 1];

  // Calculate all indicators
  const rsi = calculateRSI(close);
  const macd = calculateMACD(close);
  const bb = calculateBollingerBands(close);
  const smas = calculateSMAs(close);
  const ema20 = calculateEMA(close, 20);
  const maTrend = determineMATrend(currentPrice, smas.sma20, smas.sma50, ema20);
  const obvTrend = calculateOBVTrend(close, volume);

  // Calculate overall signal
  const overall = calculateOverallSignal({
    rsiSignal: rsi.signal,
    macdCrossover: macd.crossover,
    macdHistogram: macd.histogram,
    bbPosition: bb.position,
    maTrend,
    obvTrend,
  });

  return {
    ticker,
    // RSI
    rsi14: rsi.value,
    rsiSignal: rsi.signal,
    // MACD
    macdValue: macd.value,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    macdCrossover: macd.crossover,
    // Bollinger Bands
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    bbPosition: bb.position,
    // Moving Averages
    sma20: smas.sma20,
    sma50: smas.sma50,
    sma200: smas.sma200,
    ema20,
    maTrend,
    // OBV
    obvTrend,
    // Overall
    technicalSignal: overall.signal,
    signalStrength: overall.strength,
  };
}

/**
 * Quick technical assessment for scoring integration
 * Returns a modifier for the momentum score (-20 to +20)
 */
export function getTechnicalScoreModifier(indicators: TechnicalIndicators): number {
  let modifier = 0;

  // Bullish/bearish signal (+/- 10)
  if (indicators.technicalSignal === 'bullish') modifier += 10;
  else if (indicators.technicalSignal === 'bearish') modifier -= 10;

  // RSI extremes (+/- 5)
  if (indicators.rsiSignal === 'oversold') modifier += 5;
  else if (indicators.rsiSignal === 'overbought') modifier -= 5;

  // MACD crossover (+/- 5)
  if (indicators.macdCrossover === 'bullish') modifier += 5;
  else if (indicators.macdCrossover === 'bearish') modifier -= 5;

  return Math.max(-20, Math.min(20, modifier));
}

export default {
  fetchCandleData,
  calculateTechnicalIndicators,
  getTechnicalScoreModifier,
};
