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
    return getDemoData(type, 'not_configured');
  }

  try {
    if (type === 'account') {
      const response = await fetch(`${ALPACA_PAPER_API}/v2/account`, {
        headers: getHeaders(),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error('Alpaca account error:', body);
        // Keys ARE configured -- Alpaca refused them. Do not report this as
        // missing configuration.
        return getDemoData(type, 'auth_rejected', `HTTP ${response.status}: ${body.slice(0, 200)}`);
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

    if (type === 'portfolio-history') {
      const period = url.searchParams.get('period') || '3M';
      const timeframe = url.searchParams.get('timeframe') || '1D';
      const response = await fetch(
        `${ALPACA_PAPER_API}/v2/account/portfolio/history?period=${period}&timeframe=${timeframe}&extended_hours=false`,
        { headers: getHeaders() }
      );

      if (!response.ok) {
        console.error('Alpaca portfolio-history error:', await response.text());
        return json({ days: [] });
      }

      const raw = await response.json();
      // Alpaca returns parallel arrays; flatten into per-day objects and filter out zero-equity placeholders.
      // Timestamps are end-of-day UTC (Alpaca uses 00:00:00 UTC which is 8pm ET the previous day).
      // We need to render each row against its US/Eastern trading date, not UTC.
      const etDateFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const days: Array<{ date: string; equity: number; profitLoss: number; profitLossPct: number }> = [];
      const ts: number[] = raw.timestamp || [];
      const eq: number[] = raw.equity || [];
      const pl: number[] = raw.profit_loss || [];
      const plPct: number[] = raw.profit_loss_pct || [];
      for (let i = 0; i < ts.length; i++) {
        if (!eq[i]) continue;
        const d = new Date(ts[i] * 1000);
        // en-CA format: YYYY-MM-DD
        days.push({
          date: etDateFormatter.format(d),
          equity: eq[i],
          profitLoss: pl[i] ?? 0,
          profitLossPct: (plPct[i] ?? 0) * 100,
        });
      }
      return json({ days, baseValue: raw.base_value ?? null });
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
    return getDemoData(type, 'unreachable', String(error).slice(0, 200));
  }
};

/**
 * READ-ONLY BY DESIGN.
 *
 * This route previously exported POST (place order) and DELETE (cancel order).
 * Both were reachable by anyone who knew the deployment URL -- the only gate was
 * isConfigured(), which checks that the SERVER holds Alpaca keys, not that the
 * CALLER is authorised. An anonymous request could therefore trade on the
 * account. They are removed rather than gated because this dashboard exists to
 * audit the bot and review performance, not to place trades by hand.
 *
 * Do not reintroduce a write path here without real authentication.
 */

/**
 * `reason` distinguishes the three ways this endpoint reports connected:false.
 * Without it the portfolio page blamed missing configuration for all three,
 * including rejected keys and Alpaca outages.
 */
type DisconnectReason = 'not_configured' | 'auth_rejected' | 'unreachable';

function getDemoData(type: string, reason: DisconnectReason = 'not_configured', detail?: string) {
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
      reason,
      detail: detail ?? null,
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
