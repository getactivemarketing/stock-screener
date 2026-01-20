import 'dotenv/config';
import db from './index.js';

async function fixSchema() {
  console.log('Fixing database schema...');

  try {
    // Drop views that depend on the columns
    await db.query('DROP VIEW IF EXISTS latest_scan CASCADE;');
    await db.query('DROP VIEW IF EXISTS alert_stats CASCADE;');

    // Increase varchar sizes for fields that might be too short
    await db.query(`ALTER TABLE scan_results ALTER COLUMN exchange TYPE VARCHAR(50);`);
    await db.query(`ALTER TABLE scan_results ALTER COLUMN classification TYPE VARCHAR(50);`);
    await db.query(`ALTER TABLE scan_results ALTER COLUMN alert_type TYPE VARCHAR(50);`);
    await db.query(`ALTER TABLE scan_results ALTER COLUMN sector TYPE VARCHAR(200);`);
    await db.query(`ALTER TABLE scan_results ALTER COLUMN industry TYPE VARCHAR(200);`);

    // Recreate views
    await db.query(`
      CREATE OR REPLACE VIEW latest_scan AS
      SELECT sr.*
      FROM scan_results sr
      INNER JOIN (
        SELECT MAX(run_timestamp) as max_ts
        FROM scan_runs
        WHERE status = 'completed'
      ) latest ON sr.run_timestamp = latest.max_ts;
    `);

    await db.query(`
      CREATE OR REPLACE VIEW alert_stats AS
      SELECT
        alert_type,
        DATE(alert_timestamp) as alert_date,
        COUNT(*) as alert_count,
        AVG((scores->>'attention')::int) as avg_attention,
        AVG((scores->>'momentum')::int) as avg_momentum
      FROM alerts
      GROUP BY alert_type, DATE(alert_timestamp)
      ORDER BY alert_date DESC;
    `);

    console.log('Schema fixed successfully!');
  } catch (error) {
    console.error('Fix failed:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

fixSchema();
