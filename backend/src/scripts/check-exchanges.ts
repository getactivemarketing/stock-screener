import db from '../db/index.js';
async function main() {
  const r = await db.query(
    `SELECT ticker, exchange, country FROM scan_results
     WHERE run_id = (SELECT run_id FROM scan_runs ORDER BY run_timestamp DESC LIMIT 1)
     ORDER BY ticker`
  );
  for (const row of r) console.log(row);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
