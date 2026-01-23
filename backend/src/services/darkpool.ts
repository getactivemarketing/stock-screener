import { fetchWithRetry, RateLimiter } from '../lib/http.js';

// Rate limiter for FINRA/external APIs
const darkPoolRateLimiter = new RateLimiter(1, 1000);

// FINRA OTC Transparency data (official, but 2-4 week lag)
const FINRA_ATS_URL = 'https://api.finra.org/data/group/otcMarket/name/weeklySummary';

// Stockgrid - unofficial but more recent data
const STOCKGRID_URL = 'https://stockgrid.io/api/dark-pool';

export interface DarkPoolData {
  ticker: string;
  darkPoolVolume: number | null;
  totalVolume: number | null;
  darkPoolPercent: number | null;
  shortVolume: number | null;
  shortPercent: number | null;
  netFlow: number | null; // Positive = buying, negative = selling
  signal: 'accumulation' | 'distribution' | 'neutral';
  dataAge: 'recent' | 'delayed' | 'unknown';
  lastUpdate: string | null;
}

interface StockgridResponse {
  ticker: string;
  dark_pool_volume: number;
  total_volume: number;
  dark_pool_pct: number;
  short_volume: number;
  short_pct: number;
  net_flow: number;
  date: string;
}

interface FINRAAtsRecord {
  symbol: string;
  totalWeeklyTradeCount: number;
  totalWeeklyShareQuantity: number;
  lastUpdateDate: string;
}

/**
 * Fetch dark pool data from Stockgrid (unofficial but recent)
 */
async function fetchStockgridData(ticker: string): Promise<DarkPoolData | null> {
  try {
    // Note: Stockgrid may require scraping or have rate limits
    const url = `${STOCKGRID_URL}/${ticker.toUpperCase()}`;
    const data = await fetchWithRetry<StockgridResponse>(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      },
      darkPoolRateLimiter
    );

    if (!data || !data.dark_pool_volume) {
      return null;
    }

    const signal = determineDarkPoolSignal(data.dark_pool_pct, data.net_flow, data.short_pct);

    return {
      ticker: ticker.toUpperCase(),
      darkPoolVolume: data.dark_pool_volume,
      totalVolume: data.total_volume,
      darkPoolPercent: data.dark_pool_pct,
      shortVolume: data.short_volume,
      shortPercent: data.short_pct,
      netFlow: data.net_flow,
      signal,
      dataAge: 'recent',
      lastUpdate: data.date,
    };
  } catch (error) {
    console.warn(`Stockgrid data unavailable for ${ticker}:`, error);
    return null;
  }
}

/**
 * Fetch dark pool data from FINRA (official but delayed)
 * Note: FINRA API requires authentication for detailed queries
 */
async function fetchFINRAData(ticker: string): Promise<Partial<DarkPoolData> | null> {
  try {
    // FINRA provides weekly ATS summary data
    // This endpoint may require registration/API key
    const url = `${FINRA_ATS_URL}?symbol=${ticker.toUpperCase()}`;
    const data = await fetchWithRetry<{ data: FINRAAtsRecord[] }>(
      url,
      {
        headers: {
          'Accept': 'application/json',
        },
      },
      darkPoolRateLimiter
    );

    if (!data?.data || data.data.length === 0) {
      return null;
    }

    const latest = data.data[0];

    return {
      ticker: ticker.toUpperCase(),
      darkPoolVolume: latest.totalWeeklyShareQuantity,
      dataAge: 'delayed',
      lastUpdate: latest.lastUpdateDate,
    };
  } catch (error) {
    // FINRA API often requires authentication or may be rate limited
    console.warn(`FINRA data unavailable for ${ticker}`);
    return null;
  }
}

/**
 * Determine dark pool signal based on volume patterns
 */
function determineDarkPoolSignal(
  darkPoolPct: number | null,
  netFlow: number | null,
  shortPct: number | null
): 'accumulation' | 'distribution' | 'neutral' {
  let bullishSignals = 0;
  let bearishSignals = 0;

  // High dark pool % with positive net flow = institutional accumulation
  if (darkPoolPct !== null && darkPoolPct > 45) {
    if (netFlow !== null && netFlow > 0) {
      bullishSignals += 2;
    } else if (netFlow !== null && netFlow < 0) {
      bearishSignals += 2;
    }
  }

  // Short volume analysis
  if (shortPct !== null) {
    if (shortPct > 50) {
      // High short volume - could be bearish or covering
      bearishSignals += 1;
    } else if (shortPct < 30) {
      // Low short volume - bullish
      bullishSignals += 1;
    }
  }

  // Net flow direction
  if (netFlow !== null) {
    if (netFlow > 500000) {
      bullishSignals += 2;
    } else if (netFlow < -500000) {
      bearishSignals += 2;
    }
  }

  if (bullishSignals >= 2 && bullishSignals > bearishSignals) {
    return 'accumulation';
  } else if (bearishSignals >= 2 && bearishSignals > bullishSignals) {
    return 'distribution';
  }

  return 'neutral';
}

/**
 * Estimate dark pool activity from public volume data
 * Used as fallback when API data is unavailable
 */
function estimateDarkPoolActivity(
  totalVolume: number,
  avgVolume: number,
  priceChange: number
): Partial<DarkPoolData> {
  // Heuristic: ~40% of trading typically goes through dark pools
  const estimatedDarkPoolPct = 40;
  const estimatedDarkPoolVolume = Math.round(totalVolume * 0.4);

  // If volume is high but price didn't move much, suggests dark pool activity
  const volumeRatio = totalVolume / (avgVolume || totalVolume);
  const priceMovementRatio = Math.abs(priceChange) / 5; // Normalize to 5% move

  let signal: 'accumulation' | 'distribution' | 'neutral' = 'neutral';

  if (volumeRatio > 2 && priceMovementRatio < 0.5) {
    // High volume, low price movement = dark pool accumulation/distribution
    signal = priceChange > 0 ? 'accumulation' : 'distribution';
  }

  return {
    darkPoolVolume: estimatedDarkPoolVolume,
    totalVolume,
    darkPoolPercent: estimatedDarkPoolPct,
    signal,
    dataAge: 'unknown',
    lastUpdate: null,
  };
}

/**
 * Fetch dark pool data for a ticker
 * Tries multiple sources and falls back to estimates
 */
export async function fetchDarkPoolData(
  ticker: string,
  totalVolume?: number,
  avgVolume?: number,
  priceChange?: number
): Promise<DarkPoolData> {
  // Try Stockgrid first (most recent data)
  const stockgridData = await fetchStockgridData(ticker);
  if (stockgridData) {
    return stockgridData;
  }

  // Try FINRA (official but delayed)
  const finraData = await fetchFINRAData(ticker);
  if (finraData && finraData.darkPoolVolume) {
    return {
      ticker: ticker.toUpperCase(),
      darkPoolVolume: finraData.darkPoolVolume,
      totalVolume: totalVolume || null,
      darkPoolPercent: totalVolume ? (finraData.darkPoolVolume / totalVolume) * 100 : null,
      shortVolume: null,
      shortPercent: null,
      netFlow: null,
      signal: 'neutral',
      dataAge: finraData.dataAge || 'delayed',
      lastUpdate: finraData.lastUpdate || null,
    };
  }

  // Fall back to estimates if we have volume data
  if (totalVolume && avgVolume && priceChange !== undefined) {
    const estimated = estimateDarkPoolActivity(totalVolume, avgVolume, priceChange);
    return {
      ticker: ticker.toUpperCase(),
      darkPoolVolume: estimated.darkPoolVolume || null,
      totalVolume: estimated.totalVolume || null,
      darkPoolPercent: estimated.darkPoolPercent || null,
      shortVolume: null,
      shortPercent: null,
      netFlow: null,
      signal: estimated.signal || 'neutral',
      dataAge: 'unknown',
      lastUpdate: null,
    };
  }

  // No data available
  return {
    ticker: ticker.toUpperCase(),
    darkPoolVolume: null,
    totalVolume: null,
    darkPoolPercent: null,
    shortVolume: null,
    shortPercent: null,
    netFlow: null,
    signal: 'neutral',
    dataAge: 'unknown',
    lastUpdate: null,
  };
}

/**
 * Get dark pool score modifier for integration with main scoring
 */
export function getDarkPoolScoreModifier(data: DarkPoolData): number {
  let modifier = 0;

  // Accumulation signal is bullish
  if (data.signal === 'accumulation') {
    modifier += 5;
  } else if (data.signal === 'distribution') {
    modifier -= 5;
  }

  // High dark pool percentage with net buying
  if (data.darkPoolPercent !== null && data.darkPoolPercent > 50 && data.netFlow !== null) {
    if (data.netFlow > 0) {
      modifier += 3;
    } else if (data.netFlow < 0) {
      modifier -= 3;
    }
  }

  // Low short percentage is bullish
  if (data.shortPercent !== null) {
    if (data.shortPercent < 25) {
      modifier += 2;
    } else if (data.shortPercent > 60) {
      modifier -= 2;
    }
  }

  return Math.max(-10, Math.min(10, modifier));
}

export default {
  fetchDarkPoolData,
  getDarkPoolScoreModifier,
};
