import { config } from '../lib/config.js';
import { fetchWithRetry, RateLimiter } from '../lib/http.js';
import type { AlpacaAccount, AlpacaPosition, AlpacaOrder } from '../types/index.js';

const alpacaLimiter = new RateLimiter(1, 350); // ~200 calls/min

function getBaseUrl(): string {
  return config.alpacaPaper !== 'false'
    ? 'https://paper-api.alpaca.markets'
    : 'https://api.alpaca.markets';
}

function getDataUrl(): string {
  return 'https://data.alpaca.markets';
}

function getHeaders(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': config.alpacaApiKey || '',
    'APCA-API-SECRET-KEY': config.alpacaApiSecret || '',
    'Content-Type': 'application/json',
  };
}

export function isAlpacaConfigured(): boolean {
  return !!(config.alpacaApiKey && config.alpacaApiSecret);
}

export async function getAccount(): Promise<AlpacaAccount> {
  const raw = await fetchWithRetry<any>(
    `${getBaseUrl()}/v2/account`,
    { headers: getHeaders() },
    alpacaLimiter
  );
  return {
    id: raw.id,
    equity: parseFloat(raw.equity),
    cash: parseFloat(raw.cash),
    buyingPower: parseFloat(raw.buying_power),
    portfolioValue: parseFloat(raw.portfolio_value),
    dayPl: parseFloat(raw.equity) - parseFloat(raw.last_equity),
    dayPlPct: ((parseFloat(raw.equity) - parseFloat(raw.last_equity)) / parseFloat(raw.last_equity)) * 100,
  };
}

export async function getPositions(): Promise<AlpacaPosition[]> {
  const raw = await fetchWithRetry<any[]>(
    `${getBaseUrl()}/v2/positions`,
    { headers: getHeaders() },
    alpacaLimiter
  );
  return raw.map((p) => ({
    ticker: p.symbol,
    quantity: parseInt(p.qty),
    avgEntryPrice: parseFloat(p.avg_entry_price),
    marketValue: parseFloat(p.market_value),
    currentPrice: parseFloat(p.current_price),
    unrealizedPl: parseFloat(p.unrealized_pl),
    unrealizedPlPct: parseFloat(p.unrealized_plpc) * 100,
    side: p.side,
  }));
}

export async function getPosition(ticker: string): Promise<AlpacaPosition | null> {
  try {
    const raw = await fetchWithRetry<any>(
      `${getBaseUrl()}/v2/positions/${ticker}`,
      { headers: getHeaders() },
      alpacaLimiter
    );
    return {
      ticker: raw.symbol,
      quantity: parseInt(raw.qty),
      avgEntryPrice: parseFloat(raw.avg_entry_price),
      marketValue: parseFloat(raw.market_value),
      currentPrice: parseFloat(raw.current_price),
      unrealizedPl: parseFloat(raw.unrealized_pl),
      unrealizedPlPct: parseFloat(raw.unrealized_plpc) * 100,
      side: raw.side,
    };
  } catch {
    return null;
  }
}

interface PlaceOrderParams {
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  type: 'market' | 'limit';
  limitPrice?: number;
}

export async function placeOrder(params: PlaceOrderParams): Promise<AlpacaOrder> {
  const body: Record<string, unknown> = {
    symbol: params.ticker,
    qty: params.quantity.toString(),
    side: params.side,
    type: params.type,
    time_in_force: 'day',
  };
  if (params.type === 'limit' && params.limitPrice) {
    body.limit_price = params.limitPrice.toString();
  }

  const raw = await fetchWithRetry<any>(
    `${getBaseUrl()}/v2/orders`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    },
    alpacaLimiter
  );
  return parseOrder(raw);
}

export async function cancelOrder(orderId: string): Promise<void> {
  await fetchWithRetry<any>(
    `${getBaseUrl()}/v2/orders/${orderId}`,
    { method: 'DELETE', headers: getHeaders() },
    alpacaLimiter
  );
}

export async function getOrders(status?: 'open' | 'closed' | 'all'): Promise<AlpacaOrder[]> {
  const params = new URLSearchParams({ limit: '50' });
  if (status) params.set('status', status);

  const raw = await fetchWithRetry<any[]>(
    `${getBaseUrl()}/v2/orders?${params}`,
    { headers: getHeaders() },
    alpacaLimiter
  );
  return raw.map(parseOrder);
}

export async function getQuote(ticker: string): Promise<{ askPrice: number; bidPrice: number; lastPrice: number }> {
  const raw = await fetchWithRetry<any>(
    `${getDataUrl()}/v2/stocks/${ticker}/quotes/latest`,
    { headers: getHeaders() },
    alpacaLimiter
  );
  return {
    askPrice: raw.quote?.ap ?? 0,
    bidPrice: raw.quote?.bp ?? 0,
    lastPrice: (raw.quote?.ap + raw.quote?.bp) / 2 || 0,
  };
}

function parseOrder(raw: any): AlpacaOrder {
  return {
    id: raw.id,
    ticker: raw.symbol,
    side: raw.side,
    quantity: parseInt(raw.qty),
    type: raw.type,
    status: raw.status,
    filledAvgPrice: raw.filled_avg_price ? parseFloat(raw.filled_avg_price) : null,
    filledAt: raw.filled_at || null,
    createdAt: raw.created_at,
  };
}

export default {
  isAlpacaConfigured,
  getAccount,
  getPositions,
  getPosition,
  placeOrder,
  cancelOrder,
  getOrders,
  getQuote,
};
