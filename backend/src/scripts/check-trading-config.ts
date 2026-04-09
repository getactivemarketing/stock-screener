import db from '../db/index.js';

async function main() {
  const r = await db.query(
    `SELECT enabled, max_positions, max_position_pct, max_risk, min_fundamentals, daily_loss_limit_pct FROM trading_config WHERE id=1`
  );
  console.log(r);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
