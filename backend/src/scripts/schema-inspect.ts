import db from '../db/index.js';

async function main() {
  const tables = ['trades', 'portfolio_state', 'scan_results'];
  for (const t of tables) {
    const r = await db.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`,
      [t],
    );
    console.log(`\n=== ${t} (${r.length} cols) ===`);
    for (const c of r) console.log(`  ${c.column_name}: ${c.data_type}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
