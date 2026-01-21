import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { createHash } from 'crypto';

// Webull API endpoints
const WEBULL_API = 'https://userapi.webull.com/api';
const WEBULL_TRADE_API = 'https://tradeapi.webull.com/api/trade';
const WEBULL_QUOTE_API = 'https://quoteapi.webullbroker.com/api';

// Session state
let accessToken = '';
let refreshToken = '';
let deviceId = '';
let accountId = '';
let tradeToken = '';
let tokenExpiry = 0;
let lastLoginError = '';

function generateDeviceId(): string {
  // Generate a random device ID if not set
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 32; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function md5Hash(str: string): string {
  return createHash('md5').update(str).digest('hex');
}

// Common headers that mimic the Webull app
function getHeaders(includeAuth = false): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'did': deviceId,
    'hl': 'en',
    'os': 'web',
    'osv': 'Mozilla/5.0',
    'platform': 'web',
    'reqid': crypto.randomUUID(),
    'ver': '3.40.11',
  };

  if (includeAuth && accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  return headers;
}

async function login(): Promise<boolean> {
  const email = env.WEBULL_EMAIL;
  const password = env.WEBULL_PASSWORD;

  if (!email || !password) {
    lastLoginError = 'Webull credentials not configured';
    console.log(lastLoginError);
    return false;
  }

  // Check if token is still valid
  if (accessToken && tokenExpiry > Date.now()) {
    return true;
  }

  try {
    if (!deviceId) {
      deviceId = env.WEBULL_DEVICE_ID || generateDeviceId();
    }

    // Hash the password with MD5 (Webull requirement)
    const hashedPassword = md5Hash(password);

    // Login request
    const secResponse = await fetch(`${WEBULL_API}/passport/login/v5/account`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        account: email,
        accountType: 2, // Email
        deviceId: deviceId,
        pwd: hashedPassword,
        regionId: 1,
        deviceName: 'StockScreener',
      }),
    });

    const responseText = await secResponse.text();

    if (!secResponse.ok) {
      lastLoginError = `HTTP ${secResponse.status}: ${responseText}`;
      console.error('Webull login failed:', lastLoginError);
      return false;
    }

    let loginData;
    try {
      loginData = JSON.parse(responseText);
    } catch {
      lastLoginError = `Invalid JSON response: ${responseText.substring(0, 200)}`;
      console.error(lastLoginError);
      return false;
    }

    // Check for MFA requirement
    if (loginData.extInfo?.verifyType) {
      lastLoginError = `MFA required: ${loginData.extInfo.verifyType}. Please verify in Webull app first.`;
      console.error(lastLoginError);
      return false;
    }

    if (loginData.accessToken) {
      accessToken = loginData.accessToken;
      refreshToken = loginData.refreshToken;
      tokenExpiry = Date.now() + (loginData.tokenExpireTime || 3600) * 1000;
      lastLoginError = '';

      // Get account ID
      await fetchAccountId();

      console.log('Webull logged in successfully');
      return true;
    }

    lastLoginError = `No access token. Response: ${JSON.stringify(loginData)}`;
    console.error(lastLoginError);
    return false;
  } catch (error) {
    lastLoginError = `Exception: ${error}`;
    console.error('Webull login error:', error);
    return false;
  }
}

async function fetchAccountId(): Promise<void> {
  try {
    const response = await fetch(`${WEBULL_TRADE_API}/v2/home/account`, {
      headers: getHeaders(true),
    });

    if (response.ok) {
      const data = await response.json();
      // Look for paper trading account
      if (data.data?.accounts) {
        const paperAccount = data.data.accounts.find((a: any) =>
          a.accountType === 'PAPER' || a.brokerAccountId?.includes('paper')
        );
        accountId = paperAccount?.secAccountId || data.data.accounts[0]?.secAccountId || '';
      }
    }
  } catch (error) {
    console.error('Failed to get account ID:', error);
  }
}

async function getTradeToken(): Promise<void> {
  const pin = env.WEBULL_TRADING_PIN;
  if (!pin || !accessToken) return;

  try {
    // Hash the trading PIN
    const hashedPin = md5Hash(pin);

    const response = await fetch(`${WEBULL_TRADE_API}/trading/v1/global/trade/login`, {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify({
        pwd: hashedPin,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      tradeToken = data.data?.tradeToken || '';
    }
  } catch (error) {
    console.error('Failed to get trade token:', error);
  }
}

export const GET: RequestHandler = async ({ url }) => {
  const type = url.searchParams.get('type') || 'account';

  // Status endpoint for debugging
  if (type === 'status') {
    const hasCredentials = !!(env.WEBULL_EMAIL && env.WEBULL_PASSWORD);
    return json({
      hasCredentials,
      hasDeviceId: !!deviceId,
      hasAccessToken: !!accessToken,
      hasAccountId: !!accountId,
      tokenExpired: tokenExpiry > 0 && tokenExpiry < Date.now(),
      lastLoginError: lastLoginError || null,
      deviceId: deviceId ? `${deviceId.substring(0, 8)}...` : null,
    });
  }

  // Try to login if not already
  const loggedIn = await login();

  if (!loggedIn) {
    return getDemoData(type);
  }

  try {
    if (type === 'account') {
      const response = await fetch(`${WEBULL_TRADE_API}/v2/home/account`, {
        headers: getHeaders(true),
      });

      if (!response.ok) {
        return getDemoData(type);
      }

      const data = await response.json();
      const account = data.data?.accounts?.[0] || {};

      return json({
        accountId: accountId || 'connected',
        accountType: account.accountType || 'PAPER',
        totalValue: parseFloat(account.netLiquidation) || 0,
        cashBalance: parseFloat(account.cashBalance) || 0,
        buyingPower: parseFloat(account.dayBuyingPower) || 0,
        dayPL: parseFloat(account.dayProfitLoss) || 0,
        dayPLPercent: parseFloat(account.dayProfitLossRate) * 100 || 0,
        totalPL: parseFloat(account.unrealizedProfitLoss) || 0,
        totalPLPercent: parseFloat(account.unrealizedProfitLossRate) * 100 || 0,
        connected: true,
      });
    }

    if (type === 'positions') {
      const response = await fetch(`${WEBULL_TRADE_API}/v2/home/position`, {
        headers: {
          ...getHeaders(true),
          'sec-account-id': accountId,
        },
      });

      if (!response.ok) {
        return json([]);
      }

      const data = await response.json();
      const positions = data.data || [];

      return json(positions.map((pos: any) => ({
        ticker: pos.ticker?.symbol || '',
        quantity: parseFloat(pos.position) || 0,
        avgCost: parseFloat(pos.costPrice) || 0,
        marketValue: parseFloat(pos.marketValue) || 0,
        unrealizedPL: parseFloat(pos.unrealizedProfitLoss) || 0,
        unrealizedPLPercent: parseFloat(pos.unrealizedProfitLossRate) * 100 || 0,
        lastPrice: parseFloat(pos.lastPrice) || 0,
      })));
    }

    if (type === 'orders') {
      const response = await fetch(`${WEBULL_TRADE_API}/v2/option/list?status=All&count=20`, {
        headers: {
          ...getHeaders(true),
          'sec-account-id': accountId,
        },
      });

      if (!response.ok) {
        return json([]);
      }

      const data = await response.json();
      const orders = data.data || [];

      return json(orders.map((order: any) => ({
        orderId: order.orderId || '',
        ticker: order.ticker?.symbol || '',
        action: order.action || 'BUY',
        orderType: order.orderType || 'MKT',
        quantity: parseInt(order.totalQuantity) || 0,
        price: parseFloat(order.lmtPrice) || null,
        status: order.statusStr || order.status || 'UNKNOWN',
        filledQuantity: parseInt(order.filledQuantity) || 0,
        createTime: order.createTime || new Date().toISOString(),
      })));
    }

    return json({ error: 'Unknown type' }, { status: 400 });
  } catch (error) {
    console.error('Webull API error:', error);
    return getDemoData(type);
  }
};

export const POST: RequestHandler = async ({ request }) => {
  const loggedIn = await login();

  if (!loggedIn) {
    return json({ error: 'Not connected to Webull' }, { status: 401 });
  }

  // Get trade token if we don't have it
  if (!tradeToken) {
    await getTradeToken();
  }

  if (!tradeToken) {
    return json({ error: 'Could not get trade token. Check your PIN.' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { action, ticker, quantity, orderType, price } = body;

    if (action !== 'BUY' && action !== 'SELL') {
      return json({ error: 'Invalid action' }, { status: 400 });
    }

    // This is a simplified order placement - actual Webull API requires more steps
    return json({
      success: true,
      message: 'Paper trading orders require the full Webull SDK. Please use the Webull app for now.',
      order: {
        orderId: `sim-${Date.now()}`,
        ticker,
        action,
        orderType: orderType || 'MKT',
        quantity,
        price,
        status: 'SIMULATED',
        filledQuantity: 0,
        createTime: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Webull order error:', error);
    return json({ error: 'Failed to place order' }, { status: 500 });
  }
};

function getDemoData(type: string) {
  if (type === 'account') {
    return json({
      accountId: 'demo',
      accountType: 'DEMO',
      totalValue: 100000,
      cashBalance: 100000,
      buyingPower: 100000,
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
