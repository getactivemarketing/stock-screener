import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const WEBULL_API_BASE = process.env.BACKEND_URL || 'http://localhost:3001';

export const GET: RequestHandler = async ({ url }) => {
  const type = url.searchParams.get('type') || 'account';

  try {
    // For now, return mock data structure
    // In production, this would call the backend Webull service

    if (type === 'account') {
      return json({
        accountId: 'paper-demo',
        accountType: 'PAPER',
        totalValue: 100000,
        cashBalance: 75000,
        buyingPower: 150000,
        dayPL: 250.50,
        dayPLPercent: 0.25,
        totalPL: 1250.75,
        totalPLPercent: 1.25,
      });
    }

    if (type === 'positions') {
      return json([
        {
          ticker: 'AAPL',
          quantity: 10,
          avgCost: 175.50,
          marketValue: 1850.00,
          unrealizedPL: 95.00,
          unrealizedPLPercent: 5.41,
          lastPrice: 185.00,
        },
        {
          ticker: 'NVDA',
          quantity: 5,
          avgCost: 450.00,
          marketValue: 2500.00,
          unrealizedPL: 250.00,
          unrealizedPLPercent: 11.11,
          lastPrice: 500.00,
        },
      ]);
    }

    if (type === 'orders') {
      return json([
        {
          orderId: '12345',
          ticker: 'TSLA',
          action: 'BUY',
          orderType: 'LMT',
          quantity: 5,
          price: 200.00,
          status: 'PENDING',
          filledQuantity: 0,
          createTime: new Date().toISOString(),
        },
      ]);
    }

    return json({ error: 'Unknown type' }, { status: 400 });
  } catch (error) {
    console.error('Webull API error:', error);
    return json({ error: 'Failed to fetch Webull data' }, { status: 500 });
  }
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { action, ticker, quantity, orderType, price } = body;

    // Mock order placement
    // In production, this would call the backend Webull service

    if (action === 'BUY' || action === 'SELL') {
      return json({
        success: true,
        order: {
          orderId: `order-${Date.now()}`,
          ticker,
          action,
          orderType: orderType || 'MKT',
          quantity,
          price,
          status: 'PENDING',
          filledQuantity: 0,
          createTime: new Date().toISOString(),
        },
      });
    }

    return json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Webull order error:', error);
    return json({ error: 'Failed to place order' }, { status: 500 });
  }
};
