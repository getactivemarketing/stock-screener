import { fetchWithRetry, rateLimiters } from '../lib/http.js';
import { config } from '../lib/config.js';
import type { PriceData, FundamentalData, AlphaVantageOverview } from '../types/index.js';

const BASE_URL = 'https://www.alphavantage.co/query';

interface TimeSeriesDaily {
  'Meta Data': {
    '1. Information': string;
    '2. Symbol': string;
    '3. Last Refreshed': string;
  };
  'Time Series (Daily)': {
    [date: string]: {
      '1. open': string;
      '2. high': string;
      '3. low': string;
      '4. close': string;
      '5. volume': string;
    };
  };
}

interface GlobalQuote {
  'Global Quote': {
    '01. symbol': string;
    '02. open': string;
    '03. high': string;
    '04. low': string;
    '05. price': string;
    '06. volume': string;
    '07. latest trading day': string;
    '08. previous close': string;
    '09. change': string;
    '10. change percent': string;
  };
}

/**
 * Fetch company overview (fundamentals)
 */
export async function fetchOverview(ticker: string): Promise<FundamentalData | null> {
  try {
    const url = `${BASE_URL}?function=OVERVIEW&symbol=${ticker}&apikey=${config.alphaVantageApiKey}`;
    const data = await fetchWithRetry<AlphaVantageOverview>(
      url,
      {},
      rateLimiters.alphaVantage
    );

    // Check if we got valid data (API returns empty object for invalid tickers)
    if (!data.Symbol) {
      console.warn(`No overview data for ${ticker}`);
      return null;
    }

    return {
      ticker: data.Symbol,
      name: data.Name || '',
      sector: data.Sector || '',
      industry: data.Industry || '',
      exchange: data.Exchange || '',
      country: data.Country || '',
      marketCap: parseNumber(data.MarketCapitalization),
      sharesOutstanding: parseNumber(data.SharesOutstanding),
      peRatio: parseNullableNumber(data.PERatio),
      psRatio: parseNullableNumber(data.PriceToSalesRatioTTM),
      pbRatio: parseNullableNumber(data.PriceToBookRatio),
      epsGrowth: parseNullableNumber(data.QuarterlyEarningsGrowthYOY),
      revenueGrowth: parseNullableNumber(data.QuarterlyRevenueGrowthYOY),
      grossMargin: parseNullableNumber(data.GrossProfitTTM), // Note: this is gross profit, not margin
      operatingMargin: parseNullableNumber(data.OperatingMarginTTM),
      debtEquity: null, // Not directly available in overview
      recentFilings: 0, // Would need SEC API for this
      timestamp: new Date(),
    };
  } catch (error) {
    console.error(`Alpha Vantage overview failed for ${ticker}:`, error);
    return null;
  }
}

/**
 * Fetch current quote
 */
export async function fetchQuote(ticker: string): Promise<{ price: number; change: number; changePercent: number; volume: number } | null> {
  try {
    const url = `${BASE_URL}?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${config.alphaVantageApiKey}`;
    const data = await fetchWithRetry<GlobalQuote>(url, {}, rateLimiters.alphaVantage);

    const quote = data['Global Quote'];
    if (!quote || !quote['05. price']) {
      console.warn(`No quote data for ${ticker}`);
      return null;
    }

    return {
      price: parseFloat(quote['05. price']),
      change: parseFloat(quote['09. change']),
      changePercent: parseFloat(quote['10. change percent'].replace('%', '')),
      volume: parseInt(quote['06. volume'], 10),
    };
  } catch (error) {
    console.error(`Alpha Vantage quote failed for ${ticker}:`, error);
    return null;
  }
}

/**
 * Fetch daily time series for historical data
 */
export async function fetchDailyTimeSeries(
  ticker: string,
  outputSize: 'compact' | 'full' = 'compact'
): Promise<Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>> {
  try {
    const url = `${BASE_URL}?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=${outputSize}&apikey=${config.alphaVantageApiKey}`;
    const data = await fetchWithRetry<TimeSeriesDaily>(url, {}, rateLimiters.alphaVantage);

    const timeSeries = data['Time Series (Daily)'];
    if (!timeSeries) {
      console.warn(`No time series data for ${ticker}`);
      return [];
    }

    return Object.entries(timeSeries)
      .map(([date, values]) => ({
        date,
        open: parseFloat(values['1. open']),
        high: parseFloat(values['2. high']),
        low: parseFloat(values['3. low']),
        close: parseFloat(values['4. close']),
        volume: parseInt(values['5. volume'], 10),
      }))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } catch (error) {
    console.error(`Alpha Vantage time series failed for ${ticker}:`, error);
    return [];
  }
}

/**
 * Calculate price metrics from time series data
 */
export async function fetchPriceData(ticker: string): Promise<PriceData | null> {
  const timeSeries = await fetchDailyTimeSeries(ticker, 'compact');

  if (timeSeries.length < 2) {
    return null;
  }

  const today = timeSeries[0];
  const yesterday = timeSeries[1];
  const fiveDaysAgo = timeSeries[5] || timeSeries[timeSeries.length - 1];
  const thirtyDaysAgo = timeSeries[30] || timeSeries[Math.min(30, timeSeries.length - 1)];

  // Calculate 30-day average volume
  const last30Days = timeSeries.slice(0, 30);
  const avgVolume30d = last30Days.reduce((sum, d) => sum + d.volume, 0) / last30Days.length;

  // Find 52-week high/low (use available data)
  const allPrices = timeSeries.map((d) => ({ high: d.high, low: d.low }));
  const high52w = Math.max(...allPrices.map((p) => p.high));
  const low52w = Math.min(...allPrices.map((p) => p.low));

  return {
    ticker,
    price: today.close,
    change1d: today.close - yesterday.close,
    change1dPercent: ((today.close - yesterday.close) / yesterday.close) * 100,
    change5d: today.close - fiveDaysAgo.close,
    change5dPercent: ((today.close - fiveDaysAgo.close) / fiveDaysAgo.close) * 100,
    change30d: today.close - thirtyDaysAgo.close,
    change30dPercent: ((today.close - thirtyDaysAgo.close) / thirtyDaysAgo.close) * 100,
    volume: today.volume,
    avgVolume30d: Math.round(avgVolume30d),
    relativeVolume: today.volume / avgVolume30d,
    high52w,
    low52w,
    timestamp: new Date(),
  };
}

function parseNumber(value: string | undefined): number {
  if (!value || value === 'None' || value === '-') return 0;
  return parseInt(value, 10) || 0;
}

function parseNullableNumber(value: string | undefined): number | null {
  if (!value || value === 'None' || value === '-' || value === '0') return null;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? null : parsed;
}

export default {
  fetchOverview,
  fetchQuote,
  fetchDailyTimeSeries,
  fetchPriceData,
};
