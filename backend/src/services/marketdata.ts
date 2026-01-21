/**
 * Market Data Service
 * Fetches options flow, short interest, and other market data
 */

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

    return {
      ticker,
      callVolume,
      putVolume,
      callPutRatio: Math.round(callPutRatio * 100) / 100,
      unusualActivity,
      largestTrades: largestTrades.slice(0, 5),
    };
  } catch (error) {
    console.error(`Options flow fetch failed for ${ticker}:`, error);
    return null;
  }
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

export default {
  fetchShortInterest,
  fetchOptionsFlow,
  fetchMarketData,
  fetchHistoricalPrices,
};
