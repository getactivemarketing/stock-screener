import { fetchWithRetry, rateLimiters } from '../lib/http.js';
import { config } from '../lib/config.js';
import type { FinnhubQuote, FinnhubProfile, FundamentalData, PriceData, ClassifierEnrichment } from '../types/index.js';

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

export interface FinnhubCandle {
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
  _ticker: string,
  _resolution: 'D' | 'W' | 'M' = 'D',
  _from: number,
  _to: number
): Promise<FinnhubCandle | null> {
  // /stock/candle is a paid endpoint on Finnhub and 403s on our free plan.
  // technicals.ts has an Alpha Vantage fallback that handles the null return.
  // Short-circuit to avoid ~15s of retry noise per ticker per run.
  return null;
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

interface FinnhubPriceTarget {
  lastUpdated: string;
  symbol: string;
  targetHigh: number;
  targetLow: number;
  targetMean: number;
  targetMedian: number;
}

export async function fetchPriceTarget(_ticker: string): Promise<FinnhubPriceTarget | null> {
  // /stock/price-target is a paid endpoint on Finnhub and 403s on our free plan.
  // Callers (enrichForClassifier) already handle null by falling back to "No analyst coverage".
  // TODO: optionally replace with Yahoo Finance quoteSummary.financialData.targetMeanPrice.
  return null;
}

/**
 * Fetch all classifier enrichment data for a ticker in parallel.
 * Wraps analyst ratings, earnings, and news into one call.
 * Any individual sub-call can fail without failing the whole enrichment.
 */
export async function enrichForClassifier(
  ticker: string,
  existingHeadlines?: string[]
): Promise<ClassifierEnrichment> {
  const [recommendations, priceTarget, earnings, news] = await Promise.all([
    fetchRecommendations(ticker).catch(() => null),
    fetchPriceTarget(ticker).catch(() => null),
    fetchEarningsCalendar(ticker).catch(() => [] as FinnhubEarnings[]),
    existingHeadlines && existingHeadlines.length > 0
      ? Promise.resolve(existingHeadlines)
      : fetchNews(ticker).then(articles => articles.slice(0, 5).map(a => a.headline)).catch(() => [] as string[]),
  ]);

  // Build analyst ratings summary
  let analystRatings: ClassifierEnrichment['analystRatings'] = null;
  if (recommendations || priceTarget) {
    const parts: string[] = [];
    if (recommendations) {
      if (recommendations.strongBuy) parts.push(`Strong Buy: ${recommendations.strongBuy}`);
      if (recommendations.buy) parts.push(`Buy: ${recommendations.buy}`);
      if (recommendations.hold) parts.push(`Hold: ${recommendations.hold}`);
      if (recommendations.sell) parts.push(`Sell: ${recommendations.sell}`);
      if (recommendations.strongSell) parts.push(`Strong Sell: ${recommendations.strongSell}`);
    }
    analystRatings = {
      summary: parts.length > 0 ? parts.join(', ') : 'No analyst coverage',
      meanTarget: priceTarget?.targetMean ?? null,
      highTarget: priceTarget?.targetHigh ?? null,
      lowTarget: priceTarget?.targetLow ?? null,
    };
  }

  // Build earnings info
  let earningsInfo: ClassifierEnrichment['earnings'] = null;
  const earningsArray = Array.isArray(earnings) ? earnings : [];
  if (earningsArray.length > 0) {
    const now = new Date();
    const upcoming = earningsArray.find(e => new Date(e.date) >= now);

    // Beat rate from last 4 quarters with actual data
    const historical = earningsArray
      .filter(e => e.epsActual !== null && e.epsEstimate !== null)
      .slice(0, 4);
    const beats = historical.filter(e => (e.epsActual ?? 0) > (e.epsEstimate ?? 0)).length;
    const beatRate = historical.length > 0 ? (beats / historical.length) * 100 : null;

    earningsInfo = {
      nextDate: upcoming?.date ?? null,
      daysToEarnings: upcoming ? Math.ceil((new Date(upcoming.date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : null,
      epsEstimate: upcoming?.epsEstimate ?? null,
      earningsBeatRate: beatRate !== null ? Math.round(beatRate) : null,
    };
  }

  // News headlines
  const newsArray = Array.isArray(news) ? news : [];
  const newsHeadlines = newsArray.length > 0 ? newsArray.slice(0, 5) : null;

  return { analystRatings, earnings: earningsInfo, newsHeadlines };
}

/**
 * Export types for use in other modules
 */
export type { FinnhubNews, FinnhubInsiderTransaction, FinnhubEarnings, FinnhubRecommendation, FinnhubPriceTarget };

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
  fetchPriceTarget,
  enrichForClassifier,
};
