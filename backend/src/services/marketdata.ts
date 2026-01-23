/**
 * Market Data Service
 * Fetches options flow, short interest, and other market data
 */

import { config } from '../lib/config.js';
import { fetchWithRetry, RateLimiter } from '../lib/http.js';

// Polygon.io rate limiter (5 requests/minute for free tier)
const polygonRateLimiter = new RateLimiter(1, 12000);

export interface ShortInterestData {
  ticker: string;
  shortFloat: number; // Short % of float
  shortRatio: number; // Days to cover
  shortShares: number;
  floatShares: number;
}

export interface OptionsFlowData {
  ticker: string;
  callVolume: number;
  putVolume: number;
  callPutRatio: number;
  unusualActivity: boolean;
  maxPain: number | null;
  impliedMove: number | null;
  signal: 'bullish' | 'bearish' | 'neutral';
  largestTrades: Array<{
    type: 'call' | 'put';
    strike: number;
    expiry: string;
    volume: number;
    premium: number;
  }>;
}

/**
 * Fetch short interest data from Finviz
 */
export async function fetchShortInterest(ticker: string): Promise<ShortInterestData | null> {
  try {
    const url = `https://finviz.com/quote.ashx?t=${ticker}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();

    // Parse short float percentage
    const shortFloatMatch = html.match(/Short Float<\/td><td[^>]*>([0-9.]+)%/);
    const shortRatioMatch = html.match(/Short Ratio<\/td><td[^>]*>([0-9.]+)/);
    const sharesFloatMatch = html.match(/Shs Float<\/td><td[^>]*>([0-9.]+[BMK]?)/);

    if (!shortFloatMatch) {
      return null;
    }

    const shortFloat = parseFloat(shortFloatMatch[1]);
    const shortRatio = shortRatioMatch ? parseFloat(shortRatioMatch[1]) : 0;

    // Parse shares float (handles B, M, K suffixes)
    let floatShares = 0;
    if (sharesFloatMatch) {
      const val = sharesFloatMatch[1];
      if (val.endsWith('B')) {
        floatShares = parseFloat(val) * 1e9;
      } else if (val.endsWith('M')) {
        floatShares = parseFloat(val) * 1e6;
      } else if (val.endsWith('K')) {
        floatShares = parseFloat(val) * 1e3;
      } else {
        floatShares = parseFloat(val);
      }
    }

    const shortShares = Math.round(floatShares * (shortFloat / 100));

    return {
      ticker,
      shortFloat,
      shortRatio,
      shortShares,
      floatShares,
    };
  } catch (error) {
    console.error(`Short interest fetch failed for ${ticker}:`, error);
    return null;
  }
}

/**
 * Fetch options flow data
 * Note: Uses aggregated public data - for better data, consider paid APIs
 */
export async function fetchOptionsFlow(ticker: string): Promise<OptionsFlowData | null> {
  try {
    // Try to get options data from Yahoo Finance
    const url = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const result = data?.optionChain?.result?.[0];

    if (!result?.options?.[0]) {
      return null;
    }

    const options = result.options[0];
    const calls = options.calls || [];
    const puts = options.puts || [];

    // Calculate total volume
    let callVolume = 0;
    let putVolume = 0;
    const largestTrades: OptionsFlowData['largestTrades'] = [];

    for (const call of calls) {
      callVolume += call.volume || 0;
      if ((call.volume || 0) > 1000) {
        largestTrades.push({
          type: 'call',
          strike: call.strike,
          expiry: options.expirationDate ? new Date(options.expirationDate * 1000).toISOString().split('T')[0] : '',
          volume: call.volume || 0,
          premium: (call.lastPrice || 0) * (call.volume || 0) * 100,
        });
      }
    }

    for (const put of puts) {
      putVolume += put.volume || 0;
      if ((put.volume || 0) > 1000) {
        largestTrades.push({
          type: 'put',
          strike: put.strike,
          expiry: options.expirationDate ? new Date(options.expirationDate * 1000).toISOString().split('T')[0] : '',
          volume: put.volume || 0,
          premium: (put.lastPrice || 0) * (put.volume || 0) * 100,
        });
      }
    }

    // Sort by premium and take top 5
    largestTrades.sort((a, b) => b.premium - a.premium);

    const callPutRatio = putVolume > 0 ? callVolume / putVolume : callVolume > 0 ? 10 : 1;

    // Flag unusual activity (high volume or extreme ratio)
    const unusualActivity = callPutRatio > 3 || callPutRatio < 0.33 || (callVolume + putVolume) > 10000;

    // Calculate max pain (simplified - strike with most open interest)
    const maxPain = calculateMaxPain(calls, puts);

    // Get current price to calculate implied move
    const currentPrice = result.quote?.regularMarketPrice || 0;
    const impliedMove = calculateImpliedMove(calls, puts, currentPrice);

    // Determine options signal
    const signal = determineOptionsSignal(callPutRatio, unusualActivity, largestTrades);

    return {
      ticker,
      callVolume,
      putVolume,
      callPutRatio: Math.round(callPutRatio * 100) / 100,
      unusualActivity,
      maxPain,
      impliedMove,
      signal,
      largestTrades: largestTrades.slice(0, 5),
    };
  } catch (error) {
    console.error(`Options flow fetch failed for ${ticker}:`, error);
    return null;
  }
}

/**
 * Calculate max pain price (strike where option sellers profit most)
 */
function calculateMaxPain(calls: any[], puts: any[]): number | null {
  if (!calls.length && !puts.length) return null;

  // Get all unique strikes
  const strikes = new Set<number>();
  calls.forEach(c => strikes.add(c.strike));
  puts.forEach(p => strikes.add(p.strike));

  if (strikes.size === 0) return null;

  // Build open interest maps
  const callOI: Record<number, number> = {};
  const putOI: Record<number, number> = {};

  calls.forEach(c => {
    callOI[c.strike] = (callOI[c.strike] || 0) + (c.openInterest || 0);
  });

  puts.forEach(p => {
    putOI[p.strike] = (putOI[p.strike] || 0) + (p.openInterest || 0);
  });

  // Calculate total pain at each strike
  let minPain = Infinity;
  let maxPainStrike = 0;

  for (const strike of strikes) {
    let pain = 0;

    // Calculate call holder losses (they lose when price < strike)
    for (const [callStrike, oi] of Object.entries(callOI)) {
      if (strike > Number(callStrike)) {
        pain += (strike - Number(callStrike)) * (oi as number) * 100;
      }
    }

    // Calculate put holder losses (they lose when price > strike)
    for (const [putStrike, oi] of Object.entries(putOI)) {
      if (strike < Number(putStrike)) {
        pain += (Number(putStrike) - strike) * (oi as number) * 100;
      }
    }

    if (pain < minPain) {
      minPain = pain;
      maxPainStrike = strike;
    }
  }

  return maxPainStrike || null;
}

/**
 * Calculate implied move from options pricing
 */
function calculateImpliedMove(calls: any[], puts: any[], currentPrice: number): number | null {
  if (!currentPrice || (!calls.length && !puts.length)) return null;

  // Find ATM (at-the-money) options
  const sortedCalls = calls
    .filter(c => c.strike && c.lastPrice)
    .sort((a, b) => Math.abs(a.strike - currentPrice) - Math.abs(b.strike - currentPrice));

  const sortedPuts = puts
    .filter(p => p.strike && p.lastPrice)
    .sort((a, b) => Math.abs(a.strike - currentPrice) - Math.abs(b.strike - currentPrice));

  if (!sortedCalls.length || !sortedPuts.length) return null;

  const atmCall = sortedCalls[0];
  const atmPut = sortedPuts[0];

  // Implied move = ATM straddle price / current price * 100
  const straddlePrice = (atmCall.lastPrice || 0) + (atmPut.lastPrice || 0);
  const impliedMove = (straddlePrice / currentPrice) * 100;

  return Math.round(impliedMove * 100) / 100;
}

/**
 * Determine options signal based on flow data
 */
function determineOptionsSignal(
  callPutRatio: number,
  unusualActivity: boolean,
  largestTrades: OptionsFlowData['largestTrades']
): 'bullish' | 'bearish' | 'neutral' {
  // Check call/put ratio
  let callBias = 0;
  if (callPutRatio > 2) callBias = 2;
  else if (callPutRatio > 1.5) callBias = 1;
  else if (callPutRatio < 0.5) callBias = -2;
  else if (callPutRatio < 0.67) callBias = -1;

  // Check largest trades (smart money indicator)
  let tradeBias = 0;
  const sortedByPremium = [...largestTrades].sort((a, b) => b.premium - a.premium);
  const top3 = sortedByPremium.slice(0, 3);

  const callPremium = top3.filter(t => t.type === 'call').reduce((sum, t) => sum + t.premium, 0);
  const putPremium = top3.filter(t => t.type === 'put').reduce((sum, t) => sum + t.premium, 0);

  if (callPremium > putPremium * 2) tradeBias = 1;
  else if (putPremium > callPremium * 2) tradeBias = -1;

  // Combine signals
  const totalBias = callBias + tradeBias;

  // Only give strong signal if unusual activity detected
  if (unusualActivity) {
    if (totalBias >= 2) return 'bullish';
    if (totalBias <= -2) return 'bearish';
  } else {
    if (totalBias >= 3) return 'bullish';
    if (totalBias <= -3) return 'bearish';
  }

  return 'neutral';
}

/**
 * Fetch all market data for a ticker
 */
export async function fetchMarketData(ticker: string): Promise<{
  shortInterest: ShortInterestData | null;
  optionsFlow: OptionsFlowData | null;
}> {
  const [shortInterest, optionsFlow] = await Promise.all([
    fetchShortInterest(ticker),
    fetchOptionsFlow(ticker),
  ]);

  return { shortInterest, optionsFlow };
}

/**
 * Historical price data interface
 */
export interface HistoricalCandle {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fetch historical prices from Yahoo Finance
 * This is free and reliable for daily candles
 */
export async function fetchHistoricalPrices(
  ticker: string,
  fromDate: Date,
  toDate: Date
): Promise<HistoricalCandle[]> {
  try {
    const period1 = Math.floor(fromDate.getTime() / 1000);
    const period2 = Math.floor(toDate.getTime() / 1000);

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1d`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`Yahoo Finance historical prices failed for ${ticker}: HTTP ${response.status}`);
      return [];
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];

    if (!result?.timestamp || !result?.indicators?.quote?.[0]) {
      return [];
    }

    const timestamps = result.timestamp;
    const quote = result.indicators.quote[0];

    const candles: HistoricalCandle[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      // Skip if any price data is null
      if (
        quote.open?.[i] == null ||
        quote.high?.[i] == null ||
        quote.low?.[i] == null ||
        quote.close?.[i] == null
      ) {
        continue;
      }

      candles.push({
        date: new Date(timestamps[i] * 1000),
        open: quote.open[i],
        high: quote.high[i],
        low: quote.low[i],
        close: quote.close[i],
        volume: quote.volume?.[i] || 0,
      });
    }

    return candles;
  } catch (error) {
    console.error(`Yahoo Finance historical prices failed for ${ticker}:`, error);
    return [];
  }
}

/**
 * Fetch options data from Polygon.io (optional, requires API key)
 * More accurate than Yahoo but rate limited on free tier
 */
export async function fetchPolygonOptionsData(ticker: string): Promise<{
  callVolume: number;
  putVolume: number;
  contracts: number;
} | null> {
  // Check for Polygon API key
  const apiKey = (config as any).polygonApiKey;
  if (!apiKey) {
    return null;
  }

  try {
    const url = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&limit=100&apiKey=${apiKey}`;

    const data = await fetchWithRetry<{
      results: Array<{
        contract_type: 'call' | 'put';
        ticker: string;
      }>;
      count: number;
    }>(url, {}, polygonRateLimiter);

    if (!data?.results) {
      return null;
    }

    const callContracts = data.results.filter(c => c.contract_type === 'call').length;
    const putContracts = data.results.filter(c => c.contract_type === 'put').length;

    return {
      callVolume: callContracts,
      putVolume: putContracts,
      contracts: data.count || data.results.length,
    };
  } catch (error) {
    console.warn(`Polygon options data unavailable for ${ticker}:`, error);
    return null;
  }
}

/**
 * Get options flow score modifier for integration with main scoring
 */
export function getOptionsScoreModifier(data: OptionsFlowData | null): number {
  if (!data) return 0;

  let modifier = 0;

  // Signal direction
  if (data.signal === 'bullish') {
    modifier += 5;
  } else if (data.signal === 'bearish') {
    modifier -= 5;
  }

  // Unusual activity with bullish signal is stronger
  if (data.unusualActivity) {
    if (data.signal === 'bullish') modifier += 3;
    else if (data.signal === 'bearish') modifier -= 3;
  }

  // High call/put ratio
  if (data.callPutRatio > 3) {
    modifier += 2;
  } else if (data.callPutRatio < 0.33) {
    modifier -= 2;
  }

  return Math.max(-10, Math.min(10, modifier));
}

export default {
  fetchShortInterest,
  fetchOptionsFlow,
  fetchMarketData,
  fetchHistoricalPrices,
  fetchPolygonOptionsData,
  getOptionsScoreModifier,
};
