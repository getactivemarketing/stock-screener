/**
 * Swaggy Stocks API Service
 * Fetches options flow, sentiment, and unusual activity data
 */

// Swaggy Stocks service - note: API may be unavailable

interface SwaggyTicker {
  ticker: string;
  sentiment: number;
  mentions: number;
  momentum: number; // Change in mentions
  optionsFlow?: {
    callVolume: number;
    putVolume: number;
    callPutRatio: number;
  };
}

interface SwaggyResponse {
  data: Array<{
    symbol: string;
    sentiment: number;
    mentions: number;
    rank: number;
    previousMentions?: number;
  }>;
}

/**
 * Fetch trending tickers from Swaggy Stocks
 * Note: Swaggy Stocks API may be unavailable - this will fail gracefully
 */
export async function fetchSwaggyTrending(): Promise<SwaggyTicker[]> {
  try {
    // Try multiple potential endpoints
    const endpoints = [
      'https://api.swaggystock.com/wsb/sentiment/top',
      'https://swaggystock.com/api/wsb/sentiment',
      'https://swaggystocks.com/api/stock-data/trending',
    ];

    for (const url of endpoints) {
      try {
        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
        });

        if (response.ok) {
          const data = await response.json() as SwaggyResponse;
          const parsed = parseSwaggyData(data);
          if (parsed.length > 0) {
            return parsed;
          }
        }
      } catch {
        // Try next endpoint
        continue;
      }
    }

    console.log('    Swaggy Stocks API not available, skipping...');
    return [];
  } catch (error) {
    console.log('    Swaggy Stocks fetch failed:', (error as Error).message);
    return [];
  }
}

function parseSwaggyData(data: SwaggyResponse): SwaggyTicker[] {
  if (!data?.data || !Array.isArray(data.data)) {
    return [];
  }

  return data.data.map(item => ({
    ticker: item.symbol.toUpperCase(),
    sentiment: item.sentiment || 50,
    mentions: item.mentions || 0,
    momentum: item.previousMentions
      ? ((item.mentions - item.previousMentions) / item.previousMentions) * 100
      : 0,
  }));
}

/**
 * Fetch options flow data for a specific ticker
 */
export async function fetchOptionsFlow(ticker: string): Promise<SwaggyTicker['optionsFlow'] | null> {
  try {
    const response = await fetch(
      `https://api.swaggystock.com/options/flow/${ticker}`,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as {
      callVolume: number;
      putVolume: number;
    };

    return {
      callVolume: data.callVolume || 0,
      putVolume: data.putVolume || 0,
      callPutRatio: data.putVolume > 0 ? data.callVolume / data.putVolume : 0,
    };
  } catch {
    return null;
  }
}
