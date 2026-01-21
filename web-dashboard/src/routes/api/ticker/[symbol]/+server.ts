import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'd3d9a89r01qtc6eje74gd3d9a89r01qtc6eje750';

export const GET: RequestHandler = async ({ params, url }) => {
  const { symbol } = params;
  const dataType = url.searchParams.get('type') || 'all';

  try {
    const data: Record<string, any> = {};

    if (dataType === 'all' || dataType === 'news') {
      data.news = await fetchNews(symbol);
    }

    if (dataType === 'all' || dataType === 'insider') {
      data.insiderTransactions = await fetchInsiderTransactions(symbol);
    }

    if (dataType === 'all' || dataType === 'earnings') {
      data.earnings = await fetchEarnings(symbol);
    }

    if (dataType === 'all' || dataType === 'recommendations') {
      data.recommendations = await fetchRecommendations(symbol);
    }

    if (dataType === 'all' || dataType === 'short') {
      data.shortInterest = await fetchShortInterest(symbol);
    }

    if (dataType === 'all' || dataType === 'options') {
      data.optionsFlow = await fetchOptionsFlow(symbol);
    }

    return json(data);
  } catch (error) {
    console.error(`API error for ${symbol}:`, error);
    return json({ error: 'Failed to fetch data' }, { status: 500 });
  }
};

async function fetchNews(ticker: string) {
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = to.toISOString().split('T')[0];

    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fromStr}&to=${toStr}&token=${FINNHUB_API_KEY}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data || []).slice(0, 10);
  } catch {
    return [];
  }
}

async function fetchInsiderTransactions(ticker: string) {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/insider-transactions?symbol=${ticker}&token=${FINNHUB_API_KEY}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.data || []).slice(0, 10);
  } catch {
    return [];
  }
}

async function fetchEarnings(ticker: string) {
  try {
    const from = new Date();
    const to = new Date(from.getTime() + 90 * 24 * 60 * 60 * 1000);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = to.toISOString().split('T')[0];

    const res = await fetch(
      `https://finnhub.io/api/v1/calendar/earnings?symbol=${ticker}&from=${fromStr}&to=${toStr}&token=${FINNHUB_API_KEY}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data?.earningsCalendar || [];
  } catch {
    return [];
  }
}

async function fetchRecommendations(ticker: string) {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/recommendation?symbol=${ticker}&token=${FINNHUB_API_KEY}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.[0] || null;
  } catch {
    return null;
  }
}

async function fetchShortInterest(ticker: string) {
  try {
    const res = await fetch(`https://finviz.com/quote.ashx?t=${ticker}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    if (!res.ok) return null;

    const html = await res.text();
    const shortFloatMatch = html.match(/Short Float<\/td><td[^>]*>([0-9.]+)%/);
    const shortRatioMatch = html.match(/Short Ratio<\/td><td[^>]*>([0-9.]+)/);

    if (!shortFloatMatch) return null;

    return {
      shortFloat: parseFloat(shortFloatMatch[1]),
      shortRatio: shortRatioMatch ? parseFloat(shortRatioMatch[1]) : null,
    };
  } catch {
    return null;
  }
}

async function fetchOptionsFlow(ticker: string) {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${ticker}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const result = data?.optionChain?.result?.[0];
    if (!result?.options?.[0]) return null;

    const options = result.options[0];
    const calls = options.calls || [];
    const puts = options.puts || [];

    let callVolume = 0;
    let putVolume = 0;

    for (const call of calls) callVolume += call.volume || 0;
    for (const put of puts) putVolume += put.volume || 0;

    const callPutRatio = putVolume > 0 ? callVolume / putVolume : callVolume > 0 ? 10 : 1;

    return {
      callVolume,
      putVolume,
      callPutRatio: Math.round(callPutRatio * 100) / 100,
      unusualActivity: callPutRatio > 3 || callPutRatio < 0.33,
    };
  } catch {
    return null;
  }
}
