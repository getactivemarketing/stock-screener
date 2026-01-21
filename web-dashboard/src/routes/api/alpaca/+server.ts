import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

// Alpaca API endpoints
const ALPACA_PAPER_API = 'https://paper-api.alpaca.markets';
const ALPACA_DATA_API = 'https://data.alpaca.markets';

function getHeaders(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': env.ALPACA_API_KEY || '',
    'APCA-API-SECRET-KEY': env.ALPACA_API_SECRET || '',
    'Content-Type': 'application/json',
  };
}

function isConfigured(): boolean {
  return !!(env.ALPACA_API_KEY && env.ALPACA_API_SECRET);
}

export const GET: RequestHandler = async ({ url }) => {
  const type = url.searchParams.get('type') || 'account';

  // Status endpoint for debugging
  if (type === 'status') {
    if (!isConfigured()) {
      return json({
        configured: false,
        connected: false,
        error: 'Alpaca API credentials not configured',
      });
    }

    try {
      const response = await fetch(`${ALPACA_PAPER_API}/v2/account`, {
        headers: getHeaders(),
      });

      if (response.ok) {
        const account = await response.json();
        return json({
          configured: true,
          connected: true,
          accountId: account.id,
          status: account.status,
        });
      } else {
        const error = await response.text();
        return json({
          configured: true,
          connected: false,
          error: `HTTP ${response.status}: ${error}`,
        });
      }
    } catch (error) {
      return json({
        configured: true,
        connected: false,
        error: String(error),
      });
    }
  }

  if (!isConfigured()) {
    return getDemoData(type);
  }

  try {
    if (type === 'account') {
      const response = await fetch(`${ALPACA_PAPER_API}/v2/account`, {
        headers: getHeaders(),
      });

      if (!response.ok) {
        console.error('Alpaca account error:', await response.text());
        return getDemoData(type);
      }

      const account = await response.json();

      const totalValue = parseFloat(account.equity) || 0;
      const cash = parseFloat(account.cash) || 0;
      const lastEquity = parseFloat(account.last_equity) || totalValue;
      const dayPL = totalValue - lastEquity;
      const dayPLPercent = lastEquity > 0 ? (dayPL / lastEquity) * 100 : 0;

      return json({
        accountId: account.account_number || account.id,
        accountType: 'PAPER',
        totalValue,
        cashBalance: cash,
        buyingPower: parseFloat(account.buying_power) || 0,
        dayPL,
        dayPLPercent,
        totalPL: parseFloat(account.equity) - parseFloat(account.last_equity) || 0,
        totalPLPercent: dayPLPercent,
        connected: true,
      });
    }

    if (type === 'positions') {
      const response = await fetch(`${ALPACA_PAPER_API}/v2/positions`, {
        headers: getHeaders(),
      });

      if (!response.ok) {
        console.error('Alpaca positions error:', await response.text());
        return json([]);
      }

      const positions = await response.json();

      return json(positions.map((pos: any) => ({
        ticker: pos.symbol,
        quantity: parseFloat(pos.qty) || 0,
        avgCost: parseFloat(pos.avg_entry_price) || 0,
        marketValue: parseFloat(pos.market_value) || 0,
        unrealizedPL: parseFloat(pos.unrealized_pl) || 0,
        unrealizedPLPercent: parseFloat(pos.unrealized_plpc) * 100 || 0,
        lastPrice: parseFloat(pos.current_price) || 0,
        side: pos.side,
      })));
    }

    if (type === 'orders') {
      const response = await fetch(`${ALPACA_PAPER_API}/v2/orders?status=all&limit=50`, {
        headers: getHeaders(),
      });

      if (!response.ok) {
        console.error('Alpaca orders error:', await response.text());
        return json([]);
      }

      const orders = await response.json();

      return json(orders.map((order: any) => ({
        orderId: order.id,
        ticker: order.symbol,
        action: order.side.toUpperCase(),
        orderType: order.type.toUpperCase(),
        quantity: parseInt(order.qty) || 0,
        price: parseFloat(order.limit_price) || null,
        status: order.status.toUpperCase(),
        filledQuantity: parseInt(order.filled_qty) || 0,
        filledPrice: parseFloat(order.filled_avg_price) || null,
        createTime: order.created_at,
      })));
    }

    return json({ error: 'Unknown type' }, { status: 400 });
  } catch (error) {
    console.error('Alpaca API error:', error);
    return getDemoData(type);
  }
};

export const POST: RequestHandler = async ({ request }) => {
  if (!isConfigured()) {
    return json({ error: 'Alpaca not configured' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { action, ticker, quantity, orderType, price } = body;

    if (!ticker || !quantity || !action) {
      return json({ error: 'Missing required fields: ticker, quantity, action' }, { status: 400 });
    }

    const orderData: any = {
      symbol: ticker.toUpperCase(),
      qty: String(quantity),
      side: action.toLowerCase(),
      type: (orderType || 'market').toLowerCase(),
      time_in_force: 'day',
    };

    // Add limit price for limit orders
    if (orderType === 'LMT' && price) {
      orderData.limit_price = String(price);
    }

    const response = await fetch(`${ALPACA_PAPER_API}/v2/orders`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(orderData),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Alpaca order error:', error);
      return json({ error: `Order failed: ${error}` }, { status: response.status });
    }

    const order = await response.json();

    return json({
      success: true,
      order: {
        orderId: order.id,
        ticker: order.symbol,
        action: order.side.toUpperCase(),
        orderType: order.type.toUpperCase(),
        quantity: parseInt(order.qty),
        price: parseFloat(order.limit_price) || null,
        status: order.status.toUpperCase(),
        filledQuantity: 0,
        createTime: order.created_at,
      },
    });
  } catch (error) {
    console.error('Alpaca order error:', error);
    return json({ error: 'Failed to place order' }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ url }) => {
  const orderId = url.searchParams.get('orderId');

  if (!isConfigured()) {
    return json({ error: 'Alpaca not configured' }, { status: 401 });
  }

  if (!orderId) {
    return json({ error: 'Missing orderId' }, { status: 400 });
  }

  try {
    const response = await fetch(`${ALPACA_PAPER_API}/v2/orders/${orderId}`, {
      method: 'DELETE',
      headers: getHeaders(),
    });

    if (!response.ok) {
      const error = await response.text();
      return json({ error: `Cancel failed: ${error}` }, { status: response.status });
    }

    return json({ success: true });
  } catch (error) {
    console.error('Alpaca cancel error:', error);
    return json({ error: 'Failed to cancel order' }, { status: 500 });
  }
};

function getDemoData(type: string) {
  if (type === 'account') {
    return json({
      accountId: 'demo',
      accountType: 'DEMO',
      totalValue: 100000,
      cashBalance: 100000,
      buyingPower: 200000,
      dayPL: 0,
      dayPLPercent: 0,
      totalPL: 0,
      totalPLPercent: 0,
      connected: false,
    });
  }

  if (type === 'positions') {
    return json([]);
  }

  if (type === 'orders') {
    return json([]);
  }

  return json({ error: 'Unknown type' }, { status: 400 });
}
