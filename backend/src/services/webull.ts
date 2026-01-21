/**
 * Webull Integration Service
 * Provides paper trading, portfolio sync, and real-time market data
 */

// @ts-ignore - webull package doesn't have types
import webull from 'webull';

export interface WebullQuote {
  ticker: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  marketCap: number;
  pe: number;
  week52High: number;
  week52Low: number;
}

export interface WebullPosition {
  ticker: string;
  quantity: number;
  avgCost: number;
  marketValue: number;
  unrealizedPL: number;
  unrealizedPLPercent: number;
  lastPrice: number;
}

export interface WebullOrder {
  orderId: string;
  ticker: string;
  action: 'BUY' | 'SELL';
  orderType: 'MKT' | 'LMT' | 'STP' | 'STP_LMT';
  quantity: number;
  price?: number;
  status: string;
  filledQuantity: number;
  filledPrice?: number;
  createTime: string;
}

export interface WebullAccount {
  accountId: string;
  accountType: 'PAPER' | 'LIVE';
  totalValue: number;
  cashBalance: number;
  buyingPower: number;
  dayPL: number;
  dayPLPercent: number;
  totalPL: number;
  totalPLPercent: number;
}

class WebullService {
  private api: any;
  private isLoggedIn: boolean = false;
  private deviceId: string = '';
  private accessToken: string = '';
  private refreshToken: string = '';
  private tokenExpiry: number = 0;
  private tradeToken: string = '';
  private accountId: string = '';
  private usePaperTrading: boolean = true;

  constructor() {
    this.api = new webull();
  }

  /**
   * Initialize with credentials from environment
   */
  async init(): Promise<boolean> {
    const email = process.env.WEBULL_EMAIL;
    const password = process.env.WEBULL_PASSWORD;
    const tradingPin = process.env.WEBULL_TRADING_PIN;
    const deviceId = process.env.WEBULL_DEVICE_ID;

    if (!email || !password) {
      console.log('Webull credentials not configured');
      return false;
    }

    try {
      // Set device ID or generate one
      if (deviceId) {
        this.deviceId = deviceId;
        this.api._device_id = deviceId;
      }

      // Login
      const loginResult = await this.api.login(email, password);

      if (loginResult?.accessToken) {
        this.accessToken = loginResult.accessToken;
        this.refreshToken = loginResult.refreshToken;
        this.tokenExpiry = loginResult.tokenExpiry;
        this.isLoggedIn = true;

        // Get trade token if PIN provided (needed for orders)
        if (tradingPin) {
          const tradeTokenResult = await this.api.getTradeToken(tradingPin);
          if (tradeTokenResult) {
            this.tradeToken = tradeTokenResult;
          }
        }

        // Get account ID
        const accounts = await this.api.getAccounts();
        if (accounts?.length > 0) {
          // Prefer paper trading account
          const paperAccount = accounts.find((a: any) => a.accountType === 'PAPER');
          this.accountId = paperAccount?.accountId || accounts[0].accountId;
          this.usePaperTrading = !!paperAccount;
        }

        console.log(`Webull logged in successfully (${this.usePaperTrading ? 'Paper' : 'Live'} trading)`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('Webull login failed:', error);
      return false;
    }
  }

  /**
   * Check if logged in
   */
  isAuthenticated(): boolean {
    return this.isLoggedIn;
  }

  /**
   * Get real-time quote for a ticker
   */
  async getQuote(ticker: string): Promise<WebullQuote | null> {
    try {
      const quote = await this.api.getQuote(ticker);

      if (!quote) return null;

      return {
        ticker: ticker.toUpperCase(),
        price: quote.close || quote.price || 0,
        change: quote.change || 0,
        changePercent: quote.changeRatio * 100 || 0,
        volume: quote.volume || 0,
        high: quote.high || 0,
        low: quote.low || 0,
        open: quote.open || 0,
        prevClose: quote.preClose || 0,
        marketCap: quote.marketValue || 0,
        pe: quote.peRatio || 0,
        week52High: quote.fiftyTwoWkHigh || 0,
        week52Low: quote.fiftyTwoWkLow || 0,
      };
    } catch (error) {
      console.error(`Webull quote failed for ${ticker}:`, error);
      return null;
    }
  }

  /**
   * Get quotes for multiple tickers
   */
  async getQuotes(tickers: string[]): Promise<Map<string, WebullQuote>> {
    const quotes = new Map<string, WebullQuote>();

    // Webull API can batch requests
    for (const ticker of tickers) {
      const quote = await this.getQuote(ticker);
      if (quote) {
        quotes.set(ticker, quote);
      }
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 100));
    }

    return quotes;
  }

  /**
   * Get account summary
   */
  async getAccount(): Promise<WebullAccount | null> {
    if (!this.isLoggedIn) {
      console.log('Not logged in to Webull');
      return null;
    }

    try {
      const account = await this.api.getAccount(this.accountId);

      if (!account) return null;

      return {
        accountId: this.accountId,
        accountType: this.usePaperTrading ? 'PAPER' : 'LIVE',
        totalValue: account.netLiquidation || 0,
        cashBalance: account.cashBalance || 0,
        buyingPower: account.dayBuyingPower || 0,
        dayPL: account.dayProfitLoss || 0,
        dayPLPercent: account.dayProfitLossRate * 100 || 0,
        totalPL: account.unrealizedProfitLoss || 0,
        totalPLPercent: account.unrealizedProfitLossRate * 100 || 0,
      };
    } catch (error) {
      console.error('Failed to get Webull account:', error);
      return null;
    }
  }

  /**
   * Get current positions
   */
  async getPositions(): Promise<WebullPosition[]> {
    if (!this.isLoggedIn) {
      console.log('Not logged in to Webull');
      return [];
    }

    try {
      const positions = await this.api.getPositions(this.accountId);

      if (!positions || !Array.isArray(positions)) return [];

      return positions.map((pos: any) => ({
        ticker: pos.ticker?.symbol || pos.symbol || '',
        quantity: pos.position || 0,
        avgCost: pos.costPrice || 0,
        marketValue: pos.marketValue || 0,
        unrealizedPL: pos.unrealizedProfitLoss || 0,
        unrealizedPLPercent: (pos.unrealizedProfitLossRate || 0) * 100,
        lastPrice: pos.lastPrice || 0,
      }));
    } catch (error) {
      console.error('Failed to get Webull positions:', error);
      return [];
    }
  }

  /**
   * Get order history
   */
  async getOrders(status: 'all' | 'open' | 'filled' | 'cancelled' = 'all'): Promise<WebullOrder[]> {
    if (!this.isLoggedIn) {
      console.log('Not logged in to Webull');
      return [];
    }

    try {
      const orders = await this.api.getOrders(this.accountId, status);

      if (!orders || !Array.isArray(orders)) return [];

      return orders.map((order: any) => ({
        orderId: order.orderId || '',
        ticker: order.ticker?.symbol || order.symbol || '',
        action: order.action || 'BUY',
        orderType: order.orderType || 'MKT',
        quantity: order.totalQuantity || 0,
        price: order.lmtPrice || order.avgFilledPrice || undefined,
        status: order.status || 'UNKNOWN',
        filledQuantity: order.filledQuantity || 0,
        filledPrice: order.avgFilledPrice || undefined,
        createTime: order.createTime || '',
      }));
    } catch (error) {
      console.error('Failed to get Webull orders:', error);
      return [];
    }
  }

  /**
   * Place a paper trade order
   */
  async placeOrder(
    ticker: string,
    action: 'BUY' | 'SELL',
    quantity: number,
    orderType: 'MKT' | 'LMT' = 'MKT',
    limitPrice?: number
  ): Promise<WebullOrder | null> {
    if (!this.isLoggedIn || !this.tradeToken) {
      console.log('Not logged in or no trade token');
      return null;
    }

    if (!this.usePaperTrading) {
      console.error('Live trading not enabled - use paper trading');
      return null;
    }

    try {
      const orderResult = await this.api.placeOrder(
        this.accountId,
        this.tradeToken,
        ticker,
        action,
        orderType,
        quantity,
        limitPrice
      );

      if (orderResult?.orderId) {
        return {
          orderId: orderResult.orderId,
          ticker,
          action,
          orderType,
          quantity,
          price: limitPrice,
          status: 'PENDING',
          filledQuantity: 0,
          createTime: new Date().toISOString(),
        };
      }

      return null;
    } catch (error) {
      console.error(`Failed to place order for ${ticker}:`, error);
      return null;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.isLoggedIn || !this.tradeToken) {
      return false;
    }

    try {
      await this.api.cancelOrder(this.accountId, orderId);
      return true;
    } catch (error) {
      console.error(`Failed to cancel order ${orderId}:`, error);
      return false;
    }
  }

  /**
   * Get ticker ID (needed for some API calls)
   */
  async getTickerId(ticker: string): Promise<string | null> {
    try {
      const result = await this.api.getTickerId(ticker);
      return result || null;
    } catch (error) {
      return null;
    }
  }
}

// Singleton instance
let webullService: WebullService | null = null;

export async function getWebullService(): Promise<WebullService> {
  if (!webullService) {
    webullService = new WebullService();
    await webullService.init();
  }
  return webullService;
}

export default WebullService;
