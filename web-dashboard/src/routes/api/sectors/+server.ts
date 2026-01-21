import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/db';

export const GET: RequestHandler = async () => {
  try {
    // Get sector data from latest run
    const results = await query(`
      WITH latest_run AS (
        SELECT run_id
        FROM scan_runs
        WHERE status = 'completed' AND tickers_scanned > 0
        ORDER BY run_timestamp DESC
        LIMIT 1
      )
      SELECT
        COALESCE(sr.sector, 'Unknown') as sector,
        COUNT(*) as ticker_count,
        AVG(sr.attention_score) as avg_attention,
        AVG(sr.momentum_score) as avg_momentum,
        AVG(sr.fundamentals_score) as avg_fundamentals,
        AVG(CAST(sr.price_change_1d_pct AS FLOAT)) as avg_change_1d,
        SUM(CASE WHEN sr.classification = 'runner' THEN 1 ELSE 0 END) as runners,
        SUM(CASE WHEN sr.classification = 'value' THEN 1 ELSE 0 END) as value_plays,
        SUM(CASE WHEN sr.classification = 'avoid' THEN 1 ELSE 0 END) as avoids,
        json_agg(json_build_object(
          'ticker', sr.ticker,
          'price', sr.price,
          'change', sr.price_change_1d_pct,
          'attention', sr.attention_score,
          'classification', sr.classification
        ) ORDER BY sr.attention_score DESC) as tickers
      FROM scan_results sr
      JOIN latest_run lr ON sr.run_id = lr.run_id
      WHERE sr.sector IS NOT NULL AND sr.sector != ''
      GROUP BY sr.sector
      ORDER BY ticker_count DESC
    `);

    // Calculate heat score for each sector (for coloring)
    const sectorsWithHeat = results.map((sector: any) => ({
      ...sector,
      heatScore: calculateHeatScore(sector),
    }));

    return json(sectorsWithHeat);
  } catch (error) {
    console.error('Sectors API error:', error);
    return json({ error: 'Failed to fetch sector data' }, { status: 500 });
  }
};

function calculateHeatScore(sector: any): number {
  // Calculate a heat score from -100 (cold) to +100 (hot)
  // Based on: avg change, runners vs avoids, momentum
  const avgChange = parseFloat(sector.avg_change_1d) || 0;
  const momentum = parseFloat(sector.avg_momentum) || 50;
  const runnerRatio = sector.runners / (sector.ticker_count || 1);
  const avoidRatio = sector.avoids / (sector.ticker_count || 1);

  // Weighted formula
  const score =
    avgChange * 5 + // Price change weight
    (momentum - 50) * 0.5 + // Momentum above/below 50
    runnerRatio * 30 - // Bonus for runners
    avoidRatio * 30; // Penalty for avoids

  return Math.max(-100, Math.min(100, Math.round(score)));
}
