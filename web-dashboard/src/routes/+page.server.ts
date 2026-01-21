import { query, type ScanResult, type ScanRun } from '$lib/db';

export async function load() {
  // Get latest run info (only runs with actual results)
  const runs = await query<ScanRun>(`
    SELECT * FROM scan_runs
    WHERE status = 'completed' AND tickers_scanned > 0
    ORDER BY run_timestamp DESC
    LIMIT 1
  `);

  const latestRun = runs[0] || null;

  // Get results from latest run
  let results: ScanResult[] = [];
  if (latestRun) {
    results = await query<ScanResult>(`
      SELECT * FROM scan_results
      WHERE run_id = $1
      ORDER BY attention_score DESC, momentum_score DESC
    `, [latestRun.run_id]);
  }

  // Get stats
  const stats = {
    totalTickers: results.length,
    runners: results.filter(r => r.classification === 'runner').length,
    valuePlays: results.filter(r => r.classification === 'value').length,
    alerts: results.filter(r => r.alert_triggered).length,
  };

  return {
    results,
    latestRun,
    stats,
  };
}
