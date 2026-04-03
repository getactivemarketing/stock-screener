import { query, type ScanResult, type ScanRun } from '$lib/db';

export async function load() {
  // Get latest run info (prefer runs with 5+ tickers to skip cron misfires)
  let runs = await query<ScanRun>(`
    SELECT * FROM scan_runs
    WHERE status = 'completed' AND tickers_scanned >= 5
    ORDER BY run_timestamp DESC
    LIMIT 1
  `);
  // Fall back to any completed run if no substantial runs exist
  if (runs.length === 0) {
    runs = await query<ScanRun>(`
      SELECT * FROM scan_runs
      WHERE status = 'completed' AND tickers_scanned > 0
      ORDER BY run_timestamp DESC
      LIMIT 1
    `);
  }

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
    momentumCount: (latestRun as any)?.momentum_count ?? results.filter((r: any) => r.tier === 'MOMENTUM').length,
    qualityCount: (latestRun as any)?.quality_count ?? results.filter((r: any) => r.tier === 'QUALITY').length,
  };

  return {
    results,
    latestRun,
    stats,
  };
}
