import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/db';

export const GET: RequestHandler = async ({ url }) => {
  const type = url.searchParams.get('type') || 'summary';

  try {
    switch (type) {
      case 'summary':
        return json(await getSummaryStats());
      case 'performance':
        return json(await getPerformanceTracking());
      case 'sectors':
        return json(await getSectorAnalysis());
      case 'winrate':
        return json(await getWinRateStats());
      case 'history':
        return json(await getClassificationHistory());
      case 'backtest':
        return json(await getBacktestResults(url));
      case 'targets':
        return json(await getTargetAccuracy());
      case 'technical':
        return json(await getTechnicalSignalAccuracy());
      default:
        return json({ error: 'Unknown type' }, { status: 400 });
    }
  } catch (error) {
    console.error('Analytics API error:', error);
    return json({ error: 'Failed to fetch analytics' }, { status: 500 });
  }
};

async function getSummaryStats() {
  // Get total runs and results
  const runsResult = await query(`
    SELECT
      COUNT(*) as total_runs,
      SUM(tickers_scanned) as total_scanned,
      SUM(alerts_generated) as total_alerts
    FROM scan_runs
    WHERE status = 'completed'
  `);

  // Get classification breakdown
  const classResult = await query(`
    SELECT
      classification,
      COUNT(*) as count
    FROM scan_results
    WHERE classification IS NOT NULL
    GROUP BY classification
  `);

  // Get unique tickers
  const tickersResult = await query(`
    SELECT COUNT(DISTINCT ticker) as unique_tickers
    FROM scan_results
  `);

  return {
    totalRuns: parseInt(runsResult[0]?.total_runs || '0'),
    totalScanned: parseInt(runsResult[0]?.total_scanned || '0'),
    totalAlerts: parseInt(runsResult[0]?.total_alerts || '0'),
    uniqueTickers: parseInt(tickersResult[0]?.unique_tickers || '0'),
    classificationBreakdown: classResult,
  };
}

async function getPerformanceTracking() {
  // Get historical picks with their returns
  const results = await query(`
    SELECT
      sr.ticker,
      sr.classification,
      sr.price as entry_price,
      sr.run_timestamp,
      sr.attention_score,
      sr.momentum_score,
      sr.fundamentals_score,
      sr.return_1d,
      sr.return_3d,
      sr.return_5d,
      sr.max_gain_5d,
      sr.max_drawdown_5d
    FROM scan_results sr
    WHERE sr.classification IN ('runner', 'value', 'both')
    ORDER BY sr.run_timestamp DESC
    LIMIT 100
  `);

  return results;
}

async function getSectorAnalysis() {
  // Get sector breakdown with average scores
  const results = await query(`
    SELECT
      sector,
      COUNT(*) as ticker_count,
      AVG(attention_score) as avg_attention,
      AVG(momentum_score) as avg_momentum,
      AVG(fundamentals_score) as avg_fundamentals,
      AVG(risk_score) as avg_risk,
      COUNT(CASE WHEN classification = 'runner' THEN 1 END) as runners,
      COUNT(CASE WHEN classification = 'value' THEN 1 END) as value_plays,
      AVG(CASE WHEN return_5d IS NOT NULL THEN return_5d END) as avg_return_5d
    FROM scan_results
    WHERE sector IS NOT NULL AND sector != ''
    GROUP BY sector
    ORDER BY ticker_count DESC
  `);

  return results;
}

async function getWinRateStats() {
  // Calculate win rates for different classifications
  const results = await query(`
    SELECT
      classification,
      COUNT(*) as total_picks,
      COUNT(CASE WHEN return_1d > 0 THEN 1 END) as wins_1d,
      COUNT(CASE WHEN return_5d > 0 THEN 1 END) as wins_5d,
      COUNT(CASE WHEN max_gain_5d >= 5 THEN 1 END) as hits_5pct,
      COUNT(CASE WHEN max_gain_5d >= 10 THEN 1 END) as hits_10pct,
      COUNT(CASE WHEN max_gain_5d >= 20 THEN 1 END) as hits_20pct,
      AVG(return_1d) as avg_return_1d,
      AVG(return_5d) as avg_return_5d,
      AVG(max_gain_5d) as avg_max_gain,
      AVG(max_drawdown_5d) as avg_max_drawdown
    FROM scan_results
    WHERE classification IN ('runner', 'value', 'both')
      AND return_5d IS NOT NULL
    GROUP BY classification
  `);

  // Calculate overall stats
  const overall = await query(`
    SELECT
      COUNT(*) as total_with_returns,
      AVG(return_5d) as overall_avg_return
    FROM scan_results
    WHERE return_5d IS NOT NULL
  `);

  return {
    byClassification: results,
    overall: overall[0],
  };
}

async function getClassificationHistory() {
  // Get daily classification counts
  const results = await query(`
    SELECT
      DATE(run_timestamp) as date,
      COUNT(*) as total_tickers,
      COUNT(CASE WHEN classification = 'runner' THEN 1 END) as runners,
      COUNT(CASE WHEN classification = 'value' THEN 1 END) as value_plays,
      COUNT(CASE WHEN classification = 'both' THEN 1 END) as both,
      COUNT(CASE WHEN classification = 'avoid' THEN 1 END) as avoid,
      COUNT(CASE WHEN classification = 'watch' THEN 1 END) as watch
    FROM scan_results
    GROUP BY DATE(run_timestamp)
    ORDER BY date DESC
    LIMIT 30
  `);

  return results;
}

async function getBacktestResults(url: URL) {
  const classification = url.searchParams.get('classification') || null;
  const minAttention = url.searchParams.get('minAttention') || null;
  const limit = parseInt(url.searchParams.get('limit') || '100');

  let whereClause = 'WHERE return_5d IS NOT NULL';
  const params: any[] = [];
  let paramIndex = 1;

  if (classification) {
    whereClause += ` AND classification = $${paramIndex++}`;
    params.push(classification);
  }

  if (minAttention) {
    whereClause += ` AND attention_score >= $${paramIndex++}`;
    params.push(parseInt(minAttention));
  }

  params.push(limit);

  const results = await query(`
    SELECT
      id, ticker, run_timestamp, price, classification,
      attention_score, momentum_score, fundamentals_score, risk_score,
      return_1d, return_3d, return_5d, max_gain_5d, max_drawdown_5d,
      target_avg, stop_loss, technical_signal, technical_strength
    FROM scan_results
    ${whereClause}
    ORDER BY run_timestamp DESC
    LIMIT $${paramIndex}
  `, params);

  // Calculate hit rates
  let hitTarget = 0;
  let hitStopLoss = 0;

  for (const r of results) {
    if (r.target_avg && r.max_gain_5d) {
      const targetPct = ((Number(r.target_avg) - Number(r.price)) / Number(r.price)) * 100;
      if (Number(r.max_gain_5d) >= targetPct) hitTarget++;
    }
    if (r.stop_loss && r.max_drawdown_5d) {
      const stopPct = ((Number(r.stop_loss) - Number(r.price)) / Number(r.price)) * 100;
      if (Number(r.max_drawdown_5d) <= stopPct) hitStopLoss++;
    }
  }

  return {
    results,
    summary: {
      total: results.length,
      hitTarget,
      hitStopLoss,
      targetHitRate: results.length > 0 ? (hitTarget / results.length) * 100 : 0,
    },
  };
}

async function getTargetAccuracy() {
  const results = await query(`
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
        THEN return_5d
        ELSE NULL
      END) as avg_return_with_target,
      AVG(CASE
        WHEN target_avg IS NOT NULL
        THEN ((target_avg - price) / price * 100)
        ELSE NULL
      END) as avg_target_pct
    FROM scan_results
    WHERE return_5d IS NOT NULL
    AND target_avg IS NOT NULL
  `);

  // Get accuracy by classification
  const byClassification = await query(`
    SELECT
      classification,
      COUNT(*) as total,
      SUM(CASE
        WHEN max_gain_5d >= ((target_avg - price) / price * 100)
        THEN 1 ELSE 0
      END) as hit_target,
      AVG(return_5d) as avg_return
    FROM scan_results
    WHERE return_5d IS NOT NULL
    AND target_avg IS NOT NULL
    AND classification IS NOT NULL
    GROUP BY classification
    ORDER BY classification
  `);

  return {
    overall: results[0],
    byClassification,
  };
}

async function getTechnicalSignalAccuracy() {
  const results = await query(`
    SELECT
      technical_signal,
      COUNT(*) as total,
      SUM(CASE WHEN return_1d > 0 THEN 1 ELSE 0 END) as wins_1d,
      SUM(CASE WHEN return_5d > 0 THEN 1 ELSE 0 END) as wins_5d,
      AVG(return_1d) as avg_return_1d,
      AVG(return_5d) as avg_return_5d,
      AVG(max_gain_5d) as avg_max_gain,
      AVG(max_drawdown_5d) as avg_max_drawdown
    FROM scan_results
    WHERE return_5d IS NOT NULL
    AND technical_signal IS NOT NULL
    GROUP BY technical_signal
    ORDER BY avg_return_5d DESC
  `);

  return results;
}
