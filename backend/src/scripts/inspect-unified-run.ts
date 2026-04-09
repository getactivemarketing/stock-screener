import db from '../db/index.js';

async function main() {
  const run = await db.query<{ run_id: string; run_timestamp: Date }>(
    `SELECT run_id, run_timestamp FROM scan_runs ORDER BY run_timestamp DESC LIMIT 1`
  );
  const runId = run[0].run_id;
  console.log('Latest run:', runId, run[0].run_timestamp);

  const rows = await db.query(
    `SELECT ticker, classification, tradeable, gate_failures, entry_category, catalyst_date,
            composite_score, value_score, catalyst_score, upside_score, risk_score,
            expected_return_30d, conviction_score,
            LEFT(thesis, 100) AS thesis
     FROM scan_results
     WHERE run_id = $1
     ORDER BY composite_score DESC NULLS LAST`,
    [runId]
  );
  for (const r of rows) console.log(r);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
