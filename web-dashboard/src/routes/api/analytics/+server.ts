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
