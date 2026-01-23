import db from '../db/index.js';
import { fetchHistoricalPrices } from './marketdata.js';
import { sleep } from '../lib/http.js';

export interface ReturnData {
  return1d: number | null;
  return3d: number | null;
  return5d: number | null;
  maxGain5d: number | null;
  maxDrawdown5d: number | null;
}

export interface BacktestResult {
  id: number;
  ticker: string;
  runTimestamp: Date;
  entryPrice: number;
  classification: string;
  attention: number;
  momentum: number;
  fundamentals: number;
  risk: number;
  returns: ReturnData;
  hitTarget: boolean;
  hitStopLoss: boolean;
  targetPrice: number | null;
  stopLoss: number | null;
}

export interface ClassificationAccuracy {
  classification: string;
  totalPicks: number;
  winners1d: number;
  winners3d: number;
  winners5d: number;
  avgReturn1d: number;
  avgReturn3d: number;
  avgReturn5d: number;
  avgMaxGain: number;
  avgMaxDrawdown: number;
  winRate1d: number;
  winRate5d: number;
}

/**
 * Calculate returns for a historical scan result
 */
export async function calculateReturns(
  ticker: string,
  entryDate: Date,
  entryPrice: number
): Promise<ReturnData> {
  try {
    // Fetch price data for the next 5 days after entry
    const endDate = new Date(entryDate.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days buffer
    const candles = await fetchHistoricalPrices(ticker, entryDate, endDate);

    if (candles.length < 2) {
      return {
        return1d: null,
        return3d: null,
        return5d: null,
        maxGain5d: null,
        maxDrawdown5d: null,
      };
    }

    // Find candles by day offset
    const candlesByDay: Record<number, typeof candles[0]> = {};
    let maxHigh = entryPrice;
    let minLow = entryPrice;

    for (const candle of candles) {
      const dayDiff = Math.floor(
        (candle.date.getTime() - entryDate.getTime()) / (24 * 60 * 60 * 1000)
      );

      if (dayDiff >= 0 && dayDiff <= 5) {
        if (!candlesByDay[dayDiff]) {
          candlesByDay[dayDiff] = candle;
        }

        // Track max gain and drawdown over 5 days
        if (dayDiff <= 5) {
          maxHigh = Math.max(maxHigh, candle.high);
          minLow = Math.min(minLow, candle.low);
        }
      }
    }

    // Calculate returns
    const return1d = candlesByDay[1]
      ? ((candlesByDay[1].close - entryPrice) / entryPrice) * 100
      : null;

    const return3d = candlesByDay[3]
      ? ((candlesByDay[3].close - entryPrice) / entryPrice) * 100
      : null;

    const return5d = candlesByDay[5]
      ? ((candlesByDay[5].close - entryPrice) / entryPrice) * 100
      : null;

    const maxGain5d = ((maxHigh - entryPrice) / entryPrice) * 100;
    const maxDrawdown5d = ((minLow - entryPrice) / entryPrice) * 100;

    return {
      return1d: return1d !== null ? Math.round(return1d * 100) / 100 : null,
      return3d: return3d !== null ? Math.round(return3d * 100) / 100 : null,
      return5d: return5d !== null ? Math.round(return5d * 100) / 100 : null,
      maxGain5d: Math.round(maxGain5d * 100) / 100,
      maxDrawdown5d: Math.round(maxDrawdown5d * 100) / 100,
    };
  } catch (error) {
    console.error(`Failed to calculate returns for ${ticker}:`, error);
    return {
      return1d: null,
      return3d: null,
      return5d: null,
      maxGain5d: null,
      maxDrawdown5d: null,
    };
  }
}

/**
 * Update returns for scan results older than N days
 */
export async function updateHistoricalReturns(daysOld: number = 5): Promise<number> {
  // Get results that need return calculation
  const results = await db.query<{
    id: number;
    ticker: string;
    run_timestamp: Date;
    price: number;
    target_avg: number | null;
    stop_loss: number | null;
  }>(`
    SELECT id, ticker, run_timestamp, price, target_avg, stop_loss
    FROM scan_results
    WHERE return_5d IS NULL
    AND run_timestamp < NOW() - INTERVAL '${daysOld} days'
    AND run_timestamp > NOW() - INTERVAL '30 days'
    ORDER BY run_timestamp DESC
    LIMIT 50
  `);

  console.log(`Found ${results.length} results to update`);

  let updated = 0;

  for (const result of results) {
    const returns = await calculateReturns(
      result.ticker,
      result.run_timestamp,
      Number(result.price)
    );

    // Check if target/stop loss was hit
    let hitTarget = false;
    let hitStopLoss = false;

    if (result.target_avg && returns.maxGain5d !== null) {
      const targetPct = ((Number(result.target_avg) - Number(result.price)) / Number(result.price)) * 100;
      hitTarget = returns.maxGain5d >= targetPct;
    }

    if (result.stop_loss && returns.maxDrawdown5d !== null) {
      const stopPct = ((Number(result.stop_loss) - Number(result.price)) / Number(result.price)) * 100;
      hitStopLoss = returns.maxDrawdown5d <= stopPct;
    }

    // Update the database
    await db.query(`
      UPDATE scan_results
      SET
        return_1d = $1,
        return_3d = $2,
        return_5d = $3,
        max_gain_5d = $4,
        max_drawdown_5d = $5
      WHERE id = $6
    `, [
      returns.return1d,
      returns.return3d,
      returns.return5d,
      returns.maxGain5d,
      returns.maxDrawdown5d,
      result.id,
    ]);

    updated++;

    // Rate limiting
    await sleep(1000);

    if (updated % 10 === 0) {
      console.log(`Updated returns for ${updated}/${results.length} results`);
    }
  }

  return updated;
}

/**
 * Calculate accuracy metrics by classification
 */
export async function calculateClassificationAccuracy(): Promise<ClassificationAccuracy[]> {
  const results = await db.query<{
    classification: string;
    total_picks: number;
    winners_1d: number;
    winners_3d: number;
    winners_5d: number;
    avg_return_1d: number;
    avg_return_3d: number;
    avg_return_5d: number;
    avg_max_gain: number;
    avg_max_drawdown: number;
  }>(`
    SELECT
      classification,
      COUNT(*) as total_picks,
      SUM(CASE WHEN return_1d > 0 THEN 1 ELSE 0 END) as winners_1d,
      SUM(CASE WHEN return_3d > 0 THEN 1 ELSE 0 END) as winners_3d,
      SUM(CASE WHEN return_5d > 0 THEN 1 ELSE 0 END) as winners_5d,
      AVG(return_1d) as avg_return_1d,
      AVG(return_3d) as avg_return_3d,
      AVG(return_5d) as avg_return_5d,
      AVG(max_gain_5d) as avg_max_gain,
      AVG(max_drawdown_5d) as avg_max_drawdown
    FROM scan_results
    WHERE return_5d IS NOT NULL
    AND classification IS NOT NULL
    GROUP BY classification
    ORDER BY avg_return_5d DESC
  `);

  return results.map(r => ({
    classification: r.classification,
    totalPicks: Number(r.total_picks),
    winners1d: Number(r.winners_1d),
    winners3d: Number(r.winners_3d),
    winners5d: Number(r.winners_5d),
    avgReturn1d: Number(r.avg_return_1d) || 0,
    avgReturn3d: Number(r.avg_return_3d) || 0,
    avgReturn5d: Number(r.avg_return_5d) || 0,
    avgMaxGain: Number(r.avg_max_gain) || 0,
    avgMaxDrawdown: Number(r.avg_max_drawdown) || 0,
    winRate1d: r.total_picks > 0 ? (Number(r.winners_1d) / Number(r.total_picks)) * 100 : 0,
    winRate5d: r.total_picks > 0 ? (Number(r.winners_5d) / Number(r.total_picks)) * 100 : 0,
  }));
}

/**
 * Get detailed backtest results
 */
export async function getBacktestResults(options: {
  classification?: string;
  minAttention?: number;
  minMomentum?: number;
  limit?: number;
}): Promise<BacktestResult[]> {
  let whereClause = 'WHERE return_5d IS NOT NULL';
  const params: any[] = [];
  let paramIndex = 1;

  if (options.classification) {
    whereClause += ` AND classification = $${paramIndex++}`;
    params.push(options.classification);
  }

  if (options.minAttention) {
    whereClause += ` AND attention_score >= $${paramIndex++}`;
    params.push(options.minAttention);
  }

  if (options.minMomentum) {
    whereClause += ` AND momentum_score >= $${paramIndex++}`;
    params.push(options.minMomentum);
  }

  const limit = options.limit || 100;
  params.push(limit);

  const results = await db.query<{
    id: number;
    ticker: string;
    run_timestamp: Date;
    price: number;
    classification: string;
    attention_score: number;
    momentum_score: number;
    fundamentals_score: number;
    risk_score: number;
    return_1d: number | null;
    return_3d: number | null;
    return_5d: number | null;
    max_gain_5d: number | null;
    max_drawdown_5d: number | null;
    target_avg: number | null;
    stop_loss: number | null;
  }>(`
    SELECT
      id, ticker, run_timestamp, price, classification,
      attention_score, momentum_score, fundamentals_score, risk_score,
      return_1d, return_3d, return_5d, max_gain_5d, max_drawdown_5d,
      target_avg, stop_loss
    FROM scan_results
    ${whereClause}
    ORDER BY run_timestamp DESC
    LIMIT $${paramIndex}
  `, params);

  return results.map(r => ({
    id: r.id,
    ticker: r.ticker,
    runTimestamp: r.run_timestamp,
    entryPrice: Number(r.price),
    classification: r.classification,
    attention: r.attention_score,
    momentum: r.momentum_score,
    fundamentals: r.fundamentals_score,
    risk: r.risk_score,
    returns: {
      return1d: r.return_1d !== null ? Number(r.return_1d) : null,
      return3d: r.return_3d !== null ? Number(r.return_3d) : null,
      return5d: r.return_5d !== null ? Number(r.return_5d) : null,
      maxGain5d: r.max_gain_5d !== null ? Number(r.max_gain_5d) : null,
      maxDrawdown5d: r.max_drawdown_5d !== null ? Number(r.max_drawdown_5d) : null,
    },
    hitTarget: r.target_avg && r.max_gain_5d
      ? Number(r.max_gain_5d) >= ((Number(r.target_avg) - Number(r.price)) / Number(r.price)) * 100
      : false,
    hitStopLoss: r.stop_loss && r.max_drawdown_5d
      ? Number(r.max_drawdown_5d) <= ((Number(r.stop_loss) - Number(r.price)) / Number(r.price)) * 100
      : false,
    targetPrice: r.target_avg !== null ? Number(r.target_avg) : null,
    stopLoss: r.stop_loss !== null ? Number(r.stop_loss) : null,
  }));
}

/**
 * Calculate target price accuracy
 */
export async function calculateTargetAccuracy(): Promise<{
  totalWithTargets: number;
  hitTarget: number;
  hitStopLoss: number;
  avgDistanceToTarget: number;
  targetHitRate: number;
}> {
  const results = await db.query<{
    total: number;
    hit_target: number;
    hit_stop: number;
    avg_distance: number;
  }>(`
    SELECT
      COUNT(*) as total,
      SUM(CASE
        WHEN target_avg IS NOT NULL AND max_gain_5d >= ((target_avg - price) / price * 100)
        THEN 1 ELSE 0
      END) as hit_target,
      SUM(CASE
        WHEN stop_loss IS NOT NULL AND max_drawdown_5d <= ((stop_loss - price) / price * 100)
        THEN 1 ELSE 0
      END) as hit_stop,
      AVG(CASE
        WHEN target_avg IS NOT NULL
        THEN ABS(return_5d - ((target_avg - price) / price * 100))
        ELSE NULL
      END) as avg_distance
    FROM scan_results
    WHERE return_5d IS NOT NULL
    AND target_avg IS NOT NULL
  `);

  if (results.length === 0 || results[0].total === 0) {
    return {
      totalWithTargets: 0,
      hitTarget: 0,
      hitStopLoss: 0,
      avgDistanceToTarget: 0,
      targetHitRate: 0,
    };
  }

  const r = results[0];
  return {
    totalWithTargets: Number(r.total),
    hitTarget: Number(r.hit_target) || 0,
    hitStopLoss: Number(r.hit_stop) || 0,
    avgDistanceToTarget: Number(r.avg_distance) || 0,
    targetHitRate: Number(r.total) > 0 ? (Number(r.hit_target) / Number(r.total)) * 100 : 0,
  };
}

export default {
  calculateReturns,
  updateHistoricalReturns,
  calculateClassificationAccuracy,
  getBacktestResults,
  calculateTargetAccuracy,
};
