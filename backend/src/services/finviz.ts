/**
 * Finviz Screener Service
 * Fetches stock screener data for unusual volume, gainers, and technical setups
 */

// Finviz web scraper

interface FinvizTicker {
  ticker: string;
  company: string;
  sector: string;
  price: number;
  change: number;
  volume: number;
  relativeVolume: number;
  source: 'unusual_volume' | 'top_gainer' | 'top_loser' | 'new_high' | 'oversold';
}

/**
 * Parse Finviz HTML table to extract tickers
 */
function parseFinvizHtml(html: string): FinvizTicker[] {
  const results: FinvizTicker[] = [];

  // Match ticker symbols from the screener table
  // Looking for patterns like: <a href="quote.ashx?t=AAPL"...>AAPL</a>
  const tickerRegex = /<a[^>]*href="quote\.ashx\?t=([A-Z]+)"[^>]*class="screener-link-primary"[^>]*>([^<]+)<\/a>/gi;

  let match;
  const seen = new Set<string>();

  while ((match = tickerRegex.exec(html)) !== null) {
    const ticker = match[1].toUpperCase();
    if (!seen.has(ticker) && ticker.length <= 5) {
      seen.add(ticker);
      results.push({
        ticker,
        company: match[2] || ticker,
        sector: '',
        price: 0,
        change: 0,
        volume: 0,
        relativeVolume: 0,
        source: 'unusual_volume',
      });
    }
  }

  // Also try simpler pattern for ticker links
  const simpleTickerRegex = /quote\.ashx\?t=([A-Z]{1,5})(?:&|")/gi;
  while ((match = simpleTickerRegex.exec(html)) !== null) {
    const ticker = match[1].toUpperCase();
    if (!seen.has(ticker) && ticker.length <= 5) {
      seen.add(ticker);
      results.push({
        ticker,
        company: '',
        sector: '',
        price: 0,
        change: 0,
        volume: 0,
        relativeVolume: 0,
        source: 'unusual_volume',
      });
    }
  }

  return results;
}

/**
 * Fetch tickers with unusual volume (> 2x average)
 */
export async function fetchUnusualVolume(): Promise<FinvizTicker[]> {
  try {
    // Finviz screener for unusual volume, price under $10
    const url = 'https://finviz.com/screener.ashx?v=111&f=sh_avgvol_o500,sh_price_u10,sh_relvol_o2&ft=4&o=-relativevolume';

    const response = await fetch(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      console.log('    Finviz unusual volume returned:', response.status);
      return [];
    }

    const html = await response.text();
    const tickers = parseFinvizHtml(html);

    return tickers.map(t => ({ ...t, source: 'unusual_volume' as const }));
  } catch (error) {
    console.log('    Finviz unusual volume fetch failed:', (error as Error).message);
    return [];
  }
}

/**
 * Fetch top gainers
 */
export async function fetchTopGainers(): Promise<FinvizTicker[]> {
  try {
    // Top gainers, price under $10
    const url = 'https://finviz.com/screener.ashx?v=111&f=sh_price_u10,ta_change_u5&ft=4&o=-change';

    const response = await fetch(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      return [];
    }

    const html = await response.text();
    const tickers = parseFinvizHtml(html);

    return tickers.map(t => ({ ...t, source: 'top_gainer' as const }));
  } catch (error) {
    console.log('    Finviz gainers fetch failed:', (error as Error).message);
    return [];
  }
}

/**
 * Fetch oversold stocks (RSI < 30)
 */
export async function fetchOversold(): Promise<FinvizTicker[]> {
  try {
    // Oversold stocks with decent fundamentals
    const url = 'https://finviz.com/screener.ashx?v=111&f=fa_curratio_o1,sh_price_u10,ta_rsi_os30&ft=4';

    const response = await fetch(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      return [];
    }

    const html = await response.text();
    const tickers = parseFinvizHtml(html);

    return tickers.map(t => ({ ...t, source: 'oversold' as const }));
  } catch (error) {
    console.log('    Finviz oversold fetch failed:', (error as Error).message);
    return [];
  }
}

/**
 * Fetch stocks at new highs
 */
export async function fetchNewHighs(): Promise<FinvizTicker[]> {
  try {
    // New highs with volume
    const url = 'https://finviz.com/screener.ashx?v=111&f=sh_price_u10,ta_highlow50d_nh&ft=4&o=-relativevolume';

    const response = await fetch(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      return [];
    }

    const html = await response.text();
    const tickers = parseFinvizHtml(html);

    return tickers.map(t => ({ ...t, source: 'new_high' as const }));
  } catch (error) {
    console.log('    Finviz new highs fetch failed:', (error as Error).message);
    return [];
  }
}

/**
 * Fetch all Finviz signals and combine
 */
export async function fetchAllFinvizSignals(): Promise<FinvizTicker[]> {
  const [unusualVol, gainers, oversold, newHighs] = await Promise.all([
    fetchUnusualVolume(),
    fetchTopGainers(),
    fetchOversold(),
    fetchNewHighs(),
  ]);

  // Combine and deduplicate, keeping track of how many signals each ticker has
  const tickerMap = new Map<string, FinvizTicker & { signalCount: number }>();

  for (const ticker of [...unusualVol, ...gainers, ...oversold, ...newHighs]) {
    const existing = tickerMap.get(ticker.ticker);
    if (existing) {
      existing.signalCount++;
    } else {
      tickerMap.set(ticker.ticker, { ...ticker, signalCount: 1 });
    }
  }

  // Sort by signal count (more signals = higher priority)
  return Array.from(tickerMap.values())
    .sort((a, b) => b.signalCount - a.signalCount);
}
