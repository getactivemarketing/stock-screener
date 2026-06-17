const PAPER = 'https://paper-api.alpaca.markets';

function headers(key: string, secret: string): Record<string, string> {
  return { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' };
}

export interface AlpacaOrderResult {
  id: string | null;
  clientOrderId: string;
  status: string;
  raw?: unknown;
}

/** Place a GTC limit BUY tagged with clientOrderId. Idempotent on clientOrderId (Alpaca rejects dupes). */
export async function placeGtcLimitBuy(
  key: string, secret: string,
  ticker: string, shares: number, limitPrice: number, clientOrderId: string
): Promise<AlpacaOrderResult> {
  const res = await fetch(`${PAPER}/v2/orders`, {
    method: 'POST',
    headers: headers(key, secret),
    body: JSON.stringify({
      symbol: ticker,
      qty: String(shares),
      side: 'buy',
      type: 'limit',
      time_in_force: 'gtc',
      limit_price: String(limitPrice),
      client_order_id: clientOrderId,
    }),
  });
  const raw: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { id: null, clientOrderId, status: `error: ${raw?.message ?? res.status}`, raw };
  }
  return { id: raw?.id ?? null, clientOrderId, status: raw?.status ?? 'accepted', raw };
}

export async function getOrderById(key: string, secret: string, orderId: string): Promise<any | null> {
  const res = await fetch(`${PAPER}/v2/orders/${orderId}`, { headers: headers(key, secret) });
  if (!res.ok) return null;
  return res.json();
}

export async function cancelOrder(key: string, secret: string, orderId: string): Promise<boolean> {
  const res = await fetch(`${PAPER}/v2/orders/${orderId}`, { method: 'DELETE', headers: headers(key, secret) });
  return res.ok || res.status === 404; // 404 = already gone
}
