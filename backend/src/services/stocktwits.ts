/**
 * Stocktwits API Service
 * Fetches trending tickers and social sentiment from Stocktwits
 */

// Stocktwits API service

interface StocktwitsSymbol {
  ticker: string;
  watchlistCount: number;
  sentiment: number; // 0-100 scale
  messageVolume: number;
  trending: boolean;
}

interface StocktwitsTrendingResponse {
  symbols: Array<{
    symbol: string;
    title: string;
    watchlist_count: number;
  }>;
}

interface StocktwitsStreamResponse {
  symbol: {
    symbol: string;
    title: string;
    watchlist_count: number;
  };
  messages: Array<{
    id: number;
    body: string;
    created_at: string;
    entities: {
      sentiment?: {
        basic: 'Bullish' | 'Bearish' | null;
      };
    };
  }>;
}

/**
 * Fetch trending tickers from Stocktwits
 */
export async function fetchStocktwitsTrending(): Promise<StocktwitsSymbol[]> {
  try {
    // Stocktwits trending API
    const response = await fetch(
      'https://api.stocktwits.com/api/2/trending/symbols.json',
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'StockScreener/1.0',
        },
      }
    );

    if (!response.ok) {
      console.log('    Stocktwits trending API returned:', response.status);
      return [];
    }

    const data = await response.json() as StocktwitsTrendingResponse;

    if (!data?.symbols || !Array.isArray(data.symbols)) {
      return [];
    }

    return data.symbols.map(item => ({
      ticker: item.symbol.toUpperCase(),
      watchlistCount: item.watchlist_count || 0,
      sentiment: 50, // Will be enriched later
      messageVolume: 0,
      trending: true,
    }));
  } catch (error) {
    console.log('    Stocktwits trending fetch failed:', (error as Error).message);
    return [];
  }
}

/**
 * Fetch sentiment data for a specific ticker
 */
export async function fetchStocktwitsSentiment(ticker: string): Promise<{ sentiment: number; messageVolume: number } | null> {
  try {
    const response = await fetch(
      `https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'StockScreener/1.0',
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as StocktwitsStreamResponse;

    if (!data?.messages || !Array.isArray(data.messages)) {
      return null;
    }

    // Calculate sentiment from recent messages
    let bullish = 0;
    let bearish = 0;
    let total = 0;

    for (const msg of data.messages.slice(0, 30)) {
      const sentiment = msg.entities?.sentiment?.basic;
      if (sentiment === 'Bullish') {
        bullish++;
        total++;
      } else if (sentiment === 'Bearish') {
        bearish++;
        total++;
      }
    }

    const sentimentScore = total > 0
      ? Math.round((bullish / total) * 100)
      : 50;

    return {
      sentiment: sentimentScore,
      messageVolume: data.messages.length,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch most active tickers (high message volume)
 */
export async function fetchStocktwitsActive(): Promise<StocktwitsSymbol[]> {
  try {
    // Try to get most active symbols
    const response = await fetch(
      'https://api.stocktwits.com/api/2/trending/symbols/equities.json',
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'StockScreener/1.0',
        },
      }
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json() as StocktwitsTrendingResponse;

    if (!data?.symbols || !Array.isArray(data.symbols)) {
      return [];
    }

    return data.symbols.map(item => ({
      ticker: item.symbol.toUpperCase(),
      watchlistCount: item.watchlist_count || 0,
      sentiment: 50,
      messageVolume: 0,
      trending: true,
    }));
  } catch (error) {
    console.log('    Stocktwits active fetch failed:', (error as Error).message);
    return [];
  }
}
