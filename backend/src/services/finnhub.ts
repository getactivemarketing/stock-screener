import { fetchWithRetry, rateLimiters } from '../lib/http.js';
import { config } from '../lib/config.js';
import type { FinnhubQuote, FinnhubProfile, FundamentalData, PriceData } from '../types/index.js';

const BASE_URL = 'https://finnhub.io/api/v1';

interface FinnhubMetrics {
  metric: {
    '10DayAverageTradingVolume'?: number;
    '52WeekHigh'?: number;
    '52WeekLow'?: number;
    'peBasicExclExtraTTM'?: number;
    'psTTM'?: number;
    'pbQuarterly'?: number;
    'revenueGrowthTTMYoy'?: number;
    'grossMarginTTM'?: number;
    'operatingMarginTTM'?: number;
    'totalDebt/totalEquityQuarterly'?: number;
  };
}

interface FinnhubCandle {
  c: number[]; // close prices
  h: number[]; // high prices
  l: number[]; // low prices
  o: number[]; // open prices
  t: number[]; // timestamps
  v: number[]; // volumes
  s: string; // status
}

interface FinnhubNews {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}

/**
 * Fetch current quote
 */
export async function fetchQuote(ticker: string): Promise<FinnhubQuote | null> {
  try {
    const url = `${BASE_URL}/quote?symbol=${ticker}&token=${config.finnhubApiKey}`;
    const data = await fetchWithRetry<FinnhubQuote>(url, {}, rateLimiters.finnhub);

    if (!data.c || data.c === 0) {
      console.warn(`No quote data for ${ticker}`);
      return null;
    }

    return data;
  } catch (error) {
    console.error(`Finnhub quote failed for ${ticker}:`, error);
    return null;
  }
}

/**
 * Fetch company profile
 */
export async function fetchProfile(ticker: string): Promise<FinnhubProfile | null> {
  try {
    const url = `${BASE_URL}/stock/profile2?symbol=${ticker}&token=${config.finnhubApiKey}`;
    const data = await fetchWithRetry<FinnhubProfile>(url, {}, rateLimiters.finnhub);

    if (!data.name) {
      console.warn(`No profile data for ${ticker}`);
      return null;
    }

    return data;
  } catch (error) {
    console.error(`Finnhub profile failed for ${ticker}:`, error);
    return null;
  }
}

/**
 * Fetch basic financials / metrics
 */
export async function fetchMetrics(ticker: string): Promise<FinnhubMetrics['metric'] | null> {
  try {
    const url = `${BASE_URL}/stock/metric?symbol=${ticker}&metric=all&token=${config.finnhubApiKey}`;
    const data = await fetchWithRetry<FinnhubMetrics>(url, {}, rateLimiters.finnhub);

    return data.metric || null;
  } catch (error) {
    console.error(`Finnhub metrics failed for ${ticker}:`, error);
    return null;
  }
}

/**
 * Fetch historical candles
 */
export async function fetchCandles(
  ticker: string,
  resolution: 'D' | 'W' | 'M' = 'D',
  from: number,
  to: number
): Promise<FinnhubCandle | null> {
  try {
    const url = `${BASE_URL}/stock/candle?symbol=${ticker}&resolution=${resolution}&from=${from}&to=${to}&token=${config.finnhubApiKey}`;
    const data = await fetchWithRetry<FinnhubCandle>(url, {}, rateLimiters.finnhub);

    if (data.s !== 'ok') {
      console.warn(`No candle data for ${ticker}`);
      return null;
    }

    return data;
  } catch (error) {
    console.error(`Finnhub candles failed for ${ticker}:`, error);
    return null;
  }
}

/**
 * Fetch recent news for a ticker
 */
export async function fetchNews(ticker: string): Promise<FinnhubNews[]> {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

    const url = `${BASE_URL}/company-news?symbol=${ticker}&from=${formatDate(from)}&to=${formatDate(to)}&token=${config.finnhubApiKey}`;
    const data = await fetchWithRetry<FinnhubNews[]>(url, {}, rateLimiters.finnhub);

    return data || [];
  } catch (error) {
    console.error(`Finnhub news failed for ${ticker}:`, error);
    return [];
  }
}

/**
 * Fetch combined fundamental data using Finnhub
 */
export async function fetchFundamentalData(ticker: string): Promise<FundamentalData | null> {
  const [profile, metrics] = await Promise.all([
    fetchProfile(ticker),
    fetchMetrics(ticker),
  ]);

  if (!profile) {
    return null;
  }

  return {
    ticker,
    name: profile.name,
    sector: profile.finnhubIndustry || '',
    industry: profile.finnhubIndustry || '',
    exchange: profile.exchange,
    country: profile.country,
    marketCap: (profile.marketCapitalization || 0) * 1_000_000, // Finnhub returns in millions
    sharesOutstanding: (profile.shareOutstanding || 0) * 1_000_000,
    peRatio: metrics?.peBasicExclExtraTTM ?? null,
    psRatio: metrics?.psTTM ?? null,
    pbRatio: metrics?.pbQuarterly ?? null,
    epsGrowth: null, // Not directly available
    revenueGrowth: metrics?.revenueGrowthTTMYoy ?? null,
    grossMargin: metrics?.grossMarginTTM ?? null,
    operatingMargin: metrics?.operatingMarginTTM ?? null,
    debtEquity: metrics?.['totalDebt/totalEquityQuarterly'] ?? null,
    recentFilings: 0,
    timestamp: new Date(),
  };
}

/**
 * Fetch price data using Finnhub
 */
export async function fetchPriceData(ticker: string): Promise<PriceData | null> {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60;
  const oneYearAgo = now - 365 * 24 * 60 * 60;

  const [quote, candles30d, candles1y, metrics] = await Promise.all([
    fetchQuote(ticker),
    fetchCandles(ticker, 'D', thirtyDaysAgo, now),
    fetchCandles(ticker, 'D', oneYearAgo, now),
    fetchMetrics(ticker),
  ]);

  if (!quote || !candles30d) {
    return null;
  }

  const closes = candles30d.c;
  const volumes = candles30d.v;
  const today = closes[closes.length - 1];
  const yesterday = closes[closes.length - 2] || today;
  const fiveDaysAgo = closes[closes.length - 6] || closes[0];
  const thirtyDaysAgoPrice = closes[0];

  // Calculate average volume
  const avgVolume30d = volumes.reduce((a, b) => a + b, 0) / volumes.length;

  // 52-week high/low
  const high52w = metrics?.['52WeekHigh'] ?? (candles1y ? Math.max(...candles1y.h) : today);
  const low52w = metrics?.['52WeekLow'] ?? (candles1y ? Math.min(...candles1y.l) : today);

  return {
    ticker,
    price: quote.c,
    change1d: quote.d,
    change1dPercent: quote.dp,
    change5d: today - fiveDaysAgo,
    change5dPercent: ((today - fiveDaysAgo) / fiveDaysAgo) * 100,
    change30d: today - thirtyDaysAgoPrice,
    change30dPercent: ((today - thirtyDaysAgoPrice) / thirtyDaysAgoPrice) * 100,
    volume: volumes[volumes.length - 1] || 0,
    avgVolume30d: Math.round(avgVolume30d),
    relativeVolume: volumes[volumes.length - 1] / avgVolume30d,
    high52w,
    low52w,
    timestamp: new Date(),
  };
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export default {
  fetchQuote,
  fetchProfile,
  fetchMetrics,
  fetchCandles,
  fetchNews,
  fetchFundamentalData,
  fetchPriceData,
};
