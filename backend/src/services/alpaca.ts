import { config } from '../lib/config.js';
import { RateLimiter, sleep } from '../lib/http.js';
import type { AlpacaAccount, AlpacaPosition, AlpacaOrder } from '../types/index.js';

const alpacaLimiter = new RateLimiter(1, 350); // ~200 calls/min

// Ring buffer of recent X-Request-IDs for Alpaca support requests
const MAX_REQUEST_IDS = 50;
const recentRequestIds: Array<{ timestamp: string; method: string; path: string; requestId: string; status: number }> = [];

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

/** Get recent Alpaca X-Request-IDs for debugging/support */
export function getRecentRequestIds() {
  return [...recentRequestIds];
}

/**
 * Alpaca-specific fetch that captures X-Request-ID from response headers.
 * Retries on 429 with exponential backoff, logs request IDs for all calls.
 */
async function alpacaFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  await alpacaLimiter.acquire();

  const method = options.method || 'GET';
  const path = url.replace(getBaseUrl(), '').replace(getDataUrl(), '');
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        ...options,
        headers: { ...getHeaders(), ...(options.headers as Record<string, string> || {}) },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Capture X-Request-ID
      const requestId = response.headers.get('X-Request-ID') || response.headers.get('x-request-id') || '';
      if (requestId) {
        recentRequestIds.push({
          timestamp: new Date().toISOString(),
          method,
          path,
          requestId,
          status: response.status,
        });
        if (recentRequestIds.length > MAX_REQUEST_IDS) {
          recentRequestIds.shift();
        }
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 1000 * (attempt + 1);
        console.warn(`[Alpaca] Rate limited (429), retrying in ${waitMs}ms (X-Request-ID: ${requestId})`);
        alpacaLimiter.release();
        await sleep(waitMs);
        await alpacaLimiter.acquire();
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        alpacaLimiter.release();
        throw new Error(`Alpaca ${method} ${path} returned ${response.status}: ${body} (X-Request-ID: ${requestId})`);
      }

      // DELETE returns no body
      if (response.status === 204 || method === 'DELETE') {
        alpacaLimiter.release();
        return {} as T;
      }

      const data = await response.json() as T;
      alpacaLimiter.release();
      return data;
    } catch (error) {
      lastError = error as Error;
      if (lastError.name === 'AbortError') {
        lastError = new Error(`Alpaca ${method} ${path} timed out after 10s`);
      }
      if (attempt < 2) {
        console.warn(`[Alpaca] Attempt ${attempt + 1} failed: ${lastError.message}`);
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  alpacaLimiter.release();
  throw lastError;
}

export async function getAccount(): Promise<AlpacaAccount> {
  const raw = await alpacaFetch<any>(`${getBaseUrl()}/v2/account`);
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
  const raw = await alpacaFetch<any[]>(`${getBaseUrl()}/v2/positions`);
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
    const raw = await alpacaFetch<any>(`${getBaseUrl()}/v2/positions/${ticker}`);
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

  const raw = await alpacaFetch<any>(`${getBaseUrl()}/v2/orders`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return parseOrder(raw);
}

export async function cancelOrder(orderId: string): Promise<void> {
  await alpacaFetch<any>(`${getBaseUrl()}/v2/orders/${orderId}`, { method: 'DELETE' });
}

export async function getOrders(status?: 'open' | 'closed' | 'all'): Promise<AlpacaOrder[]> {
  const params = new URLSearchParams({ limit: '50' });
  if (status) params.set('status', status);

  const raw = await alpacaFetch<any[]>(`${getBaseUrl()}/v2/orders?${params}`);
  return raw.map(parseOrder);
}

export async function getQuote(ticker: string): Promise<{ askPrice: number; bidPrice: number; lastPrice: number }> {
  const raw = await alpacaFetch<any>(`${getDataUrl()}/v2/stocks/${ticker}/quotes/latest`);
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
  getRecentRequestIds,
};
