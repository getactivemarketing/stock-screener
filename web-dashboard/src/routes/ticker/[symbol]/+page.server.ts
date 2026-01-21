import { query, type ScanResult } from '$lib/db';
import { error } from '@sveltejs/kit';

export async function load({ params }) {
  const { symbol } = params;

  // Get latest result for this ticker
  const results = await query<ScanResult>(`
    SELECT * FROM scan_results
    WHERE ticker = $1
    ORDER BY run_timestamp DESC
    LIMIT 1
  `, [symbol.toUpperCase()]);

  if (results.length === 0) {
    throw error(404, `Ticker ${symbol} not found`);
  }

  // Get historical results for this ticker
  const history = await query<ScanResult>(`
    SELECT run_timestamp, price, attention_score, momentum_score,
           fundamentals_score, risk_score, classification
    FROM scan_results
    WHERE ticker = $1
    ORDER BY run_timestamp DESC
    LIMIT 20
  `, [symbol.toUpperCase()]);

  return {
    result: results[0],
    history,
  };
}
