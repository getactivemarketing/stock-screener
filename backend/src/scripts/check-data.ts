import 'dotenv/config';
import pg from 'pg';

async function check() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const res = await pool.query(`
    SELECT MAX(run_timestamp) as latest, COUNT(*) as total
    FROM scan_results
    WHERE DATE(run_timestamp) = CURRENT_DATE
  `);
  console.log('Latest scan:', res.rows[0].latest);
  console.log('Results today:', res.rows[0].total);

  const tech = await pool.query(`
    SELECT ticker, rsi_14, technical_signal, technical_strength
    FROM scan_results
    WHERE rsi_14 IS NOT NULL
    ORDER BY run_timestamp DESC
    LIMIT 5
  `);
  console.log('\nTechnical indicators:');
  tech.rows.forEach(r => console.log(`  ${r.ticker} - RSI: ${r.rsi_14}, Signal: ${r.technical_signal}, Strength: ${r.technical_strength}`));

  await pool.end();
}

check().catch(console.error);
