import db from '../db/index.js';
async function main() {
  const r = await db.query(
    `SELECT ticker, classification, composite_score, conviction_score, expected_return_30d,
            LEFT(thesis, 160) AS thesis
     FROM scan_results
     WHERE run_id = (SELECT run_id FROM scan_runs ORDER BY run_timestamp DESC LIMIT 1)
       AND conviction_score > 0
     ORDER BY conviction_score DESC, composite_score DESC`
  );
  for (const row of r) console.log(row);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
