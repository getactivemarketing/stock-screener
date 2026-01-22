/**
 * Reddit Penny Stock Scraper
 * Fetches trending tickers from penny stock focused subreddits
 */

import { fetchWithRetry, rateLimiters } from '../lib/http.js';
import type { SentimentData } from '../types/index.js';

// Penny stock focused subreddits
const PENNY_STOCK_SUBREDDITS = [
  'pennystocks',
  'RobinHoodPennyStocks',
  'Shortsqueeze',
  'smallstreetbets',
  'SPACs',
  'weedstocks',
];

// Regex to match stock tickers (1-5 uppercase letters, often prefixed with $)
const TICKER_REGEX = /\$?([A-Z]{1,5})\b/g;

// Common words to exclude that look like tickers
const EXCLUDED_WORDS = new Set([
  'A', 'I', 'AM', 'PM', 'CEO', 'CFO', 'IPO', 'ETF', 'NYSE', 'SEC', 'FDA', 'EPS',
  'DD', 'TA', 'PT', 'IMO', 'YOLO', 'FOMO', 'ATH', 'ATL', 'ITM', 'OTM', 'IV',
  'THE', 'FOR', 'AND', 'NOT', 'YOU', 'ALL', 'CAN', 'HER', 'WAS', 'ONE', 'OUR',
  'OUT', 'ARE', 'HAS', 'BUT', 'BE', 'ON', 'AT', 'BY', 'SO', 'IF', 'OR', 'AN',
  'UP', 'TO', 'IT', 'IS', 'IN', 'NO', 'MY', 'OF', 'AS', 'GO', 'US', 'NOW',
  'BUY', 'SELL', 'HOLD', 'LONG', 'SHORT', 'CALL', 'PUT', 'PUMP', 'DUMP',
  'EDIT', 'POST', 'LINK', 'SHARE', 'PLEASE', 'LIKE', 'NEW', 'JUST', 'BEEN',
  'WILL', 'ANY', 'WHO', 'WHAT', 'WHEN', 'WHY', 'HOW', 'MUCH', 'MANY', 'SOME',
  'MOST', 'VERY', 'THAN', 'THIS', 'THAT', 'THEM', 'YOUR', 'FROM', 'WITH',
  'INTO', 'OVER', 'ONLY', 'GOOD', 'BEST', 'ALSO', 'EVEN', 'MORE', 'BACK',
  'NEXT', 'LAST', 'WEEK', 'YEAR', 'TIME', 'TODAY', 'MOON', 'GAIN', 'LOSS',
  'RED', 'GREEN', 'HIGH', 'LOW', 'BIG', 'HUGE', 'LETS', 'GET', 'GOT', 'MADE',
]);

interface RedditPost {
  data: {
    title: string;
    selftext: string;
    score: number;
    num_comments: number;
    created_utc: number;
    upvote_ratio: number;
  };
}

interface RedditResponse {
  data: {
    children: RedditPost[];
  };
}

/**
 * Extract tickers from text
 */
function extractTickers(text: string): Map<string, number> {
  const tickers = new Map<string, number>();
  const matches = text.match(TICKER_REGEX);

  if (!matches) return tickers;

  for (const match of matches) {
    const ticker = match.replace('$', '').toUpperCase();

    // Skip excluded words and very short tickers
    if (EXCLUDED_WORDS.has(ticker)) continue;
    if (ticker.length < 2) continue;

    tickers.set(ticker, (tickers.get(ticker) || 0) + 1);
  }

  return tickers;
}

/**
 * Fetch posts from a subreddit
 */
async function fetchSubredditPosts(
  subreddit: string,
  sort: 'hot' | 'new' | 'rising' = 'hot',
  limit: number = 50
): Promise<RedditPost[]> {
  try {
    const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}`;

    const response = await fetchWithRetry<RedditResponse>(
      url,
      {
        headers: {
          'User-Agent': 'StockScreener/1.0 (stock analysis tool)',
        },
      },
      rateLimiters.reddit
    );

    return response.data?.children || [];
  } catch (error) {
    console.error(`Failed to fetch r/${subreddit}:`, error);
    return [];
  }
}

/**
 * Fetch trending penny stocks from Reddit
 */
export async function fetchRedditPennyStocks(): Promise<SentimentData[]> {
  const tickerMentions = new Map<string, {
    mentions: number;
    totalScore: number;
    totalComments: number;
    postCount: number;
  }>();

  console.log('  Fetching from Reddit penny stock subreddits...');

  // Fetch from all penny stock subreddits
  for (const subreddit of PENNY_STOCK_SUBREDDITS) {
    try {
      // Get hot and new posts
      const [hotPosts, newPosts] = await Promise.all([
        fetchSubredditPosts(subreddit, 'hot', 25),
        fetchSubredditPosts(subreddit, 'new', 25),
      ]);

      const posts = [...hotPosts, ...newPosts];
      console.log(`    r/${subreddit}: ${posts.length} posts`);

      for (const post of posts) {
        const { title, selftext, score, num_comments } = post.data;
        const text = `${title} ${selftext}`;
        const tickers = extractTickers(text);

        for (const [ticker, count] of tickers) {
          const existing = tickerMentions.get(ticker) || {
            mentions: 0,
            totalScore: 0,
            totalComments: 0,
            postCount: 0,
          };

          existing.mentions += count;
          existing.totalScore += score;
          existing.totalComments += num_comments;
          existing.postCount += 1;

          tickerMentions.set(ticker, existing);
        }
      }

      // Small delay between subreddits
      await new Promise(r => setTimeout(r, 1000));
    } catch (error) {
      console.error(`  Error fetching r/${subreddit}:`, error);
    }
  }

  // Convert to SentimentData format
  const results: SentimentData[] = [];

  // Sort by mentions and take top tickers
  const sortedTickers = Array.from(tickerMentions.entries())
    .filter(([_, data]) => data.mentions >= 2) // At least 2 mentions
    .sort((a, b) => b[1].mentions - a[1].mentions);

  let rank = 1;
  for (const [ticker, data] of sortedTickers) {
    // Calculate sentiment based on upvotes and engagement
    const avgScore = data.totalScore / data.postCount;
    const avgComments = data.totalComments / data.postCount;

    // Higher scores and more comments = more positive sentiment
    let sentiment = 50; // Neutral baseline
    if (avgScore > 100) sentiment += 20;
    else if (avgScore > 50) sentiment += 10;
    else if (avgScore > 10) sentiment += 5;

    if (avgComments > 50) sentiment += 15;
    else if (avgComments > 20) sentiment += 10;
    else if (avgComments > 5) sentiment += 5;

    // More mentions = higher sentiment
    if (data.mentions > 10) sentiment += 10;
    else if (data.mentions > 5) sentiment += 5;

    results.push({
      ticker,
      source: 'reddit-penny' as any,
      mentions: data.mentions,
      sentiment: Math.min(100, sentiment),
      rank,
      momentum: data.mentions > 5 ? 1.5 : 1.0,
      timestamp: new Date(),
    });

    rank++;
  }

  console.log(`    Total unique penny stock tickers: ${results.length}`);
  return results;
}

export default {
  fetchRedditPennyStocks,
};
