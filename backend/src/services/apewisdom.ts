import { fetchWithRetry, rateLimiters } from '../lib/http.js';
import type { SentimentData, ApeWisdomResponse } from '../types/index.js';

const BASE_URL = 'https://apewisdom.io/api/v1.0';

interface ApeWisdomTrendingResponse {
  results: ApeWisdomResponse[];
}

/**
 * Fetch trending stocks from ApeWisdom
 * This API is public and doesn't require authentication
 */
export async function fetchTrendingStocks(
  filter: 'all-stocks' | 'wallstreetbets' | 'stocks' | 'pennystocks' = 'all-stocks'
): Promise<SentimentData[]> {
  try {
    const url = `${BASE_URL}/filter/${filter}`;
    const response = await fetchWithRetry<ApeWisdomTrendingResponse>(
      url,
      {},
      rateLimiters.apewisdom
    );

    return response.results.map((item) => ({
      ticker: item.ticker,
      source: 'apewisdom' as const,
      mentions: item.mentions || 0,
      sentiment: calculateSentimentFromRank(item.rank, item.mentions),
      momentum: calculateMomentum(item.rank, item.rank_24h_ago),
      rank: item.rank,
      timestamp: new Date(),
    }));
  } catch (error) {
    console.error('ApeWisdom fetch failed:', error);
    return [];
  }
}

/**
 * Fetch data for specific tickers from ApeWisdom
 */
export async function fetchTickerSentiment(ticker: string): Promise<SentimentData | null> {
  try {
    // ApeWisdom doesn't have a direct ticker endpoint, so we fetch all and filter
    const trending = await fetchTrendingStocks('all-stocks');
    return trending.find((t) => t.ticker === ticker.toUpperCase()) || null;
  } catch (error) {
    console.error(`ApeWisdom fetch for ${ticker} failed:`, error);
    return null;
  }
}

/**
 * Calculate a sentiment score based on rank and mentions
 * Higher rank = more popular = positive sentiment proxy
 */
function calculateSentimentFromRank(rank: number, mentions: number): number {
  // Top 10 = very high attention
  if (rank <= 10) return 80 + Math.min(20, mentions / 100);
  // Top 50 = high attention
  if (rank <= 50) return 50 + (50 - rank);
  // Top 100 = moderate
  if (rank <= 100) return 25 + (100 - rank) / 2;
  // Beyond 100
  return Math.max(0, 25 - (rank - 100) / 10);
}

/**
 * Calculate momentum based on rank change
 */
function calculateMomentum(currentRank: number, previousRank?: number): number {
  if (!previousRank || previousRank === 0) return 1;

  // If rank improved (lower number), momentum > 1
  // If rank worsened (higher number), momentum < 1
  const ratio = previousRank / currentRank;
  return Math.max(0.1, Math.min(10, ratio)); // Cap between 0.1x and 10x
}

export default {
  fetchTrendingStocks,
  fetchTickerSentiment,
};
