/**
 * Return Tracker Script
 *
 * Runs daily to calculate historical returns for past picks.
 * Updates scan_results with return_1d, return_3d, return_5d, max_gain_5d, max_drawdown_5d
 */

import db from './db/index.js';
import { fetchHistoricalPrices } from './services/marketdata.js';

interface PendingPick {
  id: number;
  ticker: string;
  run_timestamp: Date;
  price: number;
}

interface ReturnData {
  return_1d: number | null;
  return_3d: number | null;
  return_5d: number | null;
  max_gain_5d: number | null;
  max_drawdown_5d: number | null;
}

/**
 * Get picks that need return data calculated
 * Picks must be at least 1 day old and not have return data yet
 */
async function getPendingPicks(): Promise<PendingPick[]> {
  const result = await db.query(`
    SELECT id, ticker, run_timestamp, price
    FROM scan_results
    WHERE return_1d IS NULL
      AND price IS NOT NULL
      AND price > 0
      AND run_timestamp < NOW() - INTERVAL '1 day'
      AND run_timestamp > NOW() - INTERVAL '30 days'
      AND classification IN ('runner', 'value', 'both', 'watch')
    ORDER BY run_timestamp DESC
    LIMIT 100
  `);

  return result;
}

/**
 * Calculate returns for a single pick
 */
async function calculateReturns(pick: PendingPick): Promise<ReturnData> {
  const entryDate = new Date(pick.run_timestamp);
  const now = new Date();

  // Fetch daily candles from Yahoo Finance
  const candles = await fetchHistoricalPrices(pick.ticker, entryDate, now);

  if (!candles || candles.length === 0) {
    console.log(`No candle data for ${pick.ticker}`);
    return {
      return_1d: null,
      return_3d: null,
      return_5d: null,
      max_gain_5d: null,
      max_drawdown_5d: null,
    };
  }

  const entryPrice = pick.price;

  // Extract arrays from candles
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // Calculate returns (percentage)
  const return_1d = closes.length >= 1
    ? ((closes[0] - entryPrice) / entryPrice) * 100
    : null;

  const return_3d = closes.length >= 3
    ? ((closes[2] - entryPrice) / entryPrice) * 100
    : null;

  const return_5d = closes.length >= 5
    ? ((closes[4] - entryPrice) / entryPrice) * 100
    : null;

  // Calculate max gain and drawdown over 5 days (or available days)
  const daysToCheck = Math.min(5, highs.length);
  let maxHigh = entryPrice;
  let minLow = entryPrice;

  for (let i = 0; i < daysToCheck; i++) {
    if (highs[i] > maxHigh) maxHigh = highs[i];
    if (lows[i] < minLow) minLow = lows[i];
  }

  const max_gain_5d = ((maxHigh - entryPrice) / entryPrice) * 100;
  const max_drawdown_5d = ((entryPrice - minLow) / entryPrice) * 100;

  return {
    return_1d,
    return_3d,
    return_5d,
    max_gain_5d,
    max_drawdown_5d,
  };
}

/**
 * Update pick with calculated returns
 */
async function updatePickReturns(pickId: number, returns: ReturnData): Promise<void> {
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
    returns.return_1d,
    returns.return_3d,
    returns.return_5d,
    returns.max_gain_5d,
    returns.max_drawdown_5d,
    pickId,
  ]);
}

/**
 * Store price history for backtesting
 */
async function storePriceHistory(
  ticker: string,
  candles: Array<{ date: Date; open: number; high: number; low: number; close: number; volume: number }>
): Promise<void> {
  if (!candles || candles.length === 0) return;

  for (const candle of candles) {
    const date = candle.date.toISOString().split('T')[0];

    try {
      await db.query(`
        INSERT INTO price_history (ticker, date, open, high, low, close, volume)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (ticker, date) DO UPDATE SET
          open = EXCLUDED.open,
          high = EXCLUDED.high,
          low = EXCLUDED.low,
          close = EXCLUDED.close,
          volume = EXCLUDED.volume
      `, [
        ticker,
        date,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
      ]);
    } catch (error) {
      // Ignore duplicate key errors
      if (!(error instanceof Error && error.message.includes('duplicate'))) {
        console.error(`Failed to store price history for ${ticker} ${date}:`, error);
      }
    }
  }
}

/**
 * Main function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('Return Tracker - Starting');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  try {
    // Get picks needing return calculation
    const pendingPicks = await getPendingPicks();
    console.log(`\nFound ${pendingPicks.length} picks needing return data`);

    if (pendingPicks.length === 0) {
      console.log('No picks to process. Exiting.');
      return;
    }

    let processed = 0;
    let updated = 0;
    let errors = 0;

    // Process each pick
    for (const pick of pendingPicks) {
      try {
        console.log(`\nProcessing ${pick.ticker} (ID: ${pick.id}, Entry: $${pick.price})`);

        // Calculate returns
        const returns = await calculateReturns(pick);

        if (returns.return_1d !== null) {
          // Update the pick
          await updatePickReturns(pick.id, returns);
          updated++;

          console.log(`  Return 1D: ${returns.return_1d?.toFixed(2)}%`);
          console.log(`  Return 3D: ${returns.return_3d?.toFixed(2) || 'N/A'}%`);
          console.log(`  Return 5D: ${returns.return_5d?.toFixed(2) || 'N/A'}%`);
          console.log(`  Max Gain: ${returns.max_gain_5d?.toFixed(2)}%`);
          console.log(`  Max DD: -${returns.max_drawdown_5d?.toFixed(2)}%`);
        } else {
          console.log(`  No price data available`);
        }

        processed++;

        // Rate limiting - wait 200ms between API calls
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (error) {
        console.error(`  Error processing ${pick.ticker}:`, error);
        errors++;
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('Return Tracker - Complete');
    console.log(`Processed: ${processed}`);
    console.log(`Updated: ${updated}`);
    console.log(`Errors: ${errors}`);
    console.log('='.repeat(60));

    // Print win rate summary
    await printWinRateSummary();

  } catch (error) {
    console.error('Return tracker failed:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

/**
 * Print win rate summary after processing
 */
async function printWinRateSummary(): Promise<void> {
  try {
    const result = await db.query(`
      SELECT
        classification,
        COUNT(*) as total,
        COUNT(CASE WHEN return_1d > 0 THEN 1 END) as wins_1d,
        COUNT(CASE WHEN return_5d > 0 THEN 1 END) as wins_5d,
        AVG(return_1d) as avg_return_1d,
        AVG(return_5d) as avg_return_5d,
        AVG(max_gain_5d) as avg_max_gain,
        AVG(max_drawdown_5d) as avg_max_dd
      FROM scan_results
      WHERE return_1d IS NOT NULL
        AND classification IN ('runner', 'value', 'both')
      GROUP BY classification
      ORDER BY classification
    `);

    if (result.length > 0) {
      console.log('\nWin Rate Summary:');
      console.log('-'.repeat(80));
      console.log(
        'Class'.padEnd(10),
        'Total'.padStart(6),
        'Win 1D'.padStart(8),
        'Win 5D'.padStart(8),
        'Avg 1D'.padStart(8),
        'Avg 5D'.padStart(8),
        'Avg Max'.padStart(8),
        'Avg DD'.padStart(8)
      );
      console.log('-'.repeat(80));

      for (const row of result) {
        const winRate1d = row.total > 0 ? ((row.wins_1d / row.total) * 100).toFixed(1) : '0.0';
        const winRate5d = row.total > 0 ? ((row.wins_5d / row.total) * 100).toFixed(1) : '0.0';

        console.log(
          row.classification.padEnd(10),
          String(row.total).padStart(6),
          `${winRate1d}%`.padStart(8),
          `${winRate5d}%`.padStart(8),
          `${parseFloat(row.avg_return_1d || 0).toFixed(2)}%`.padStart(8),
          `${parseFloat(row.avg_return_5d || 0).toFixed(2)}%`.padStart(8),
          `${parseFloat(row.avg_max_gain || 0).toFixed(2)}%`.padStart(8),
          `${parseFloat(row.avg_max_dd || 0).toFixed(2)}%`.padStart(8)
        );
      }
      console.log('-'.repeat(80));
    }
  } catch (error) {
    console.error('Failed to print win rate summary:', error);
  }
}

// Run the tracker
main();
