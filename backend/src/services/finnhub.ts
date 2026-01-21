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

interface FinnhubInsiderTransaction {
  symbol: string;
  name: string;
  share: number;
  change: number;
  filingDate: string;
  transactionDate: string;
  transactionCode: string;
  transactionPrice: number;
}

interface FinnhubEarnings {
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  hour: string;
  quarter: number;
  revenueActual: number | null;
  revenueEstimate: number | null;
  symbol: string;
  year: number;
}

interface FinnhubRecommendation {
  buy: number;
  hold: number;
  period: string;
  sell: number;
  strongBuy: number;
  strongSell: number;
  symbol: string;
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
 * Fetch price data using Finnhub (free tier - no historical candles)
 * Uses quote + metrics endpoints only
 */
export async function fetchPriceData(ticker: string): Promise<PriceData | null> {
  const [quote, metrics] = await Promise.all([
    fetchQuote(ticker),
    fetchMetrics(ticker),
  ]);

  if (!quote) {
    return null;
  }

  // Get 52-week high/low from metrics
  const high52w = metrics?.['52WeekHigh'] ?? quote.c;
  const low52w = metrics?.['52WeekLow'] ?? quote.c;

  // Get average volume from metrics (10-day average in millions)
  const avgVolume10d = (metrics?.['10DayAverageTradingVolume'] ?? 1) * 1_000_000;

  // Estimate current volume from quote (daily high-low range as proxy for activity)
  // Note: Finnhub quote doesn't include volume directly, so we estimate
  const estimatedVolume = avgVolume10d; // Use average as estimate

  // Calculate relative volume (will be ~1 since we're using average as current)
  const relativeVolume = 1.0;

  // For 5d and 30d changes, we only have 1d from quote
  // Use 1d change as approximation (or could set to 0)
  const change1d = quote.d || 0;
  const change1dPercent = quote.dp || 0;

  return {
    ticker,
    price: quote.c,
    change1d,
    change1dPercent,
    change5d: change1d, // Approximation - only have 1d data
    change5dPercent: change1dPercent,
    change30d: change1d, // Approximation - only have 1d data
    change30dPercent: change1dPercent,
    volume: estimatedVolume,
    avgVolume30d: Math.round(avgVolume10d),
    relativeVolume,
    high52w,
    low52w,
    timestamp: new Date(),
  };
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Fetch insider transactions for a ticker
 */
export async function fetchInsiderTransactions(ticker: string): Promise<FinnhubInsiderTransaction[]> {
  try {
    const url = `${BASE_URL}/stock/insider-transactions?symbol=${ticker}&token=${config.finnhubApiKey}`;
    const data = await fetchWithRetry<{ data: FinnhubInsiderTransaction[] }>(url, {}, rateLimiters.finnhub);
    return data?.data?.slice(0, 10) || []; // Last 10 transactions
  } catch (error) {
    console.error(`Finnhub insider transactions failed for ${ticker}:`, error);
    return [];
  }
}

/**
 * Fetch earnings calendar for a ticker
 */
export async function fetchEarningsCalendar(ticker: string): Promise<FinnhubEarnings[]> {
  try {
    const from = new Date();
    const to = new Date(from.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days ahead

    const url = `${BASE_URL}/calendar/earnings?symbol=${ticker}&from=${formatDate(from)}&to=${formatDate(to)}&token=${config.finnhubApiKey}`;
    const data = await fetchWithRetry<{ earningsCalendar: FinnhubEarnings[] }>(url, {}, rateLimiters.finnhub);
    return data?.earningsCalendar || [];
  } catch (error) {
    console.error(`Finnhub earnings failed for ${ticker}:`, error);
    return [];
  }
}

/**
 * Fetch analyst recommendations
 */
export async function fetchRecommendations(ticker: string): Promise<FinnhubRecommendation | null> {
  try {
    const url = `${BASE_URL}/stock/recommendation?symbol=${ticker}&token=${config.finnhubApiKey}`;
    const data = await fetchWithRetry<FinnhubRecommendation[]>(url, {}, rateLimiters.finnhub);
    return data?.[0] || null; // Most recent recommendation
  } catch (error) {
    console.error(`Finnhub recommendations failed for ${ticker}:`, error);
    return null;
  }
}

/**
 * Export types for use in other modules
 */
export type { FinnhubNews, FinnhubInsiderTransaction, FinnhubEarnings, FinnhubRecommendation };

export default {
  fetchQuote,
  fetchProfile,
  fetchMetrics,
  fetchCandles,
  fetchNews,
  fetchFundamentalData,
  fetchPriceData,
  fetchInsiderTransactions,
  fetchEarningsCalendar,
  fetchRecommendations,
};
