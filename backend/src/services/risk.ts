import type { AlpacaAccount, TradingConfig, RiskCheckResult } from '../types/index.js';

/**
 * Anything occupying a position slot: a real holding, a working buy order, or a
 * buy already approved earlier in this cycle. AlpacaPosition satisfies this
 * structurally, so existing callers are unaffected.
 */
export interface PositionLike {
  ticker: string;
  marketValue: number;
}

/**
 * Pre-trade risk validation. Called before every BUY order.
 *
 * `positions` must be the COMMITTED portfolio, not just Alpaca's filled
 * positions — see buildCommitted(). Passing only filled positions is what let
 * the account reach 10 positions and 99% heat against limits of 5 and 40%:
 * unfilled orders and same-cycle approvals were invisible to every check below.
 */
export function validateBuy(
  ticker: string,
  orderValue: number,
  account: AlpacaAccount,
  positions: PositionLike[],
  config: TradingConfig
): RiskCheckResult {
  // Check daily loss limit — blocks ALL buys
  if (account.dayPlPct <= -config.dailyLossLimitPct) {
    return { approved: false, reason: `Daily loss limit hit (${account.dayPlPct.toFixed(2)}% <= -${config.dailyLossLimitPct}%)` };
  }

  // Check max positions
  if (positions.length >= config.maxPositions) {
    return { approved: false, reason: `Max positions reached (${positions.length}/${config.maxPositions})` };
  }

  // Check no duplicate position
  if (positions.some((p) => p.ticker === ticker)) {
    return { approved: false, reason: `Already holding ${ticker}` };
  }

  // Check buying power
  if (orderValue > account.buyingPower) {
    return { approved: false, reason: `Insufficient buying power ($${orderValue.toFixed(2)} > $${account.buyingPower.toFixed(2)})` };
  }

  // Check position size as % of portfolio
  const positionPct = (orderValue / account.portfolioValue) * 100;
  if (positionPct > config.maxPositionPct) {
    // Reduce to max allowed
    const maxOrderValue = account.portfolioValue * (config.maxPositionPct / 100);
    // We can't compute adjusted quantity without knowing the price, so just reject
    // The caller should handle reducing the order size
    return { approved: false, reason: `Position size ${positionPct.toFixed(1)}% exceeds max ${config.maxPositionPct}%` };
  }

  // Check portfolio heat (total exposure)
  const totalExposure = positions.reduce((sum, p) => sum + p.marketValue, 0) + orderValue;
  const heatPct = (totalExposure / account.portfolioValue) * 100;
  if (heatPct > config.maxPortfolioHeatPct) {
    return { approved: false, reason: `Portfolio heat too high (${heatPct.toFixed(1)}% > ${config.maxPortfolioHeatPct}%)` };
  }

  return { approved: true };
}

export default { validateBuy };
