import db from '../db/index.js';
async function main() {
  const r = await db.query(
    `SELECT ticker, exchange, country, gate_failures FROM scan_results
     WHERE run_id = (SELECT run_id FROM scan_runs ORDER BY run_timestamp DESC LIMIT 1)
       AND 'not_us_listed' = ANY(gate_failures)`
  );
  for (const row of r) console.log(row);
  // Tradeable summary
  const total = await db.query(
    `SELECT COUNT(*) FILTER (WHERE tradeable) AS tradeable, COUNT(*) AS total
     FROM scan_results WHERE run_id = (SELECT run_id FROM scan_runs ORDER BY run_timestamp DESC LIMIT 1)`
  );
  console.log('Tradeable:', total[0]);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
