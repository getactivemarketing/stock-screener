import 'dotenv/config';
import pg from 'pg';

console.log('Connecting to database...');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  console.log('Running database migrations...');

  const client = await pool.connect();

  try {
    // Phase 1: Technical indicator columns
    const technicalColumns = [
      { name: 'rsi_14', type: 'DECIMAL(5,2)' },
      { name: 'macd_value', type: 'DECIMAL(10,4)' },
      { name: 'macd_signal', type: 'DECIMAL(10,4)' },
      { name: 'macd_histogram', type: 'DECIMAL(10,4)' },
      { name: 'bb_upper', type: 'DECIMAL(10,4)' },
      { name: 'bb_middle', type: 'DECIMAL(10,4)' },
      { name: 'bb_lower', type: 'DECIMAL(10,4)' },
      { name: 'sma_20', type: 'DECIMAL(10,4)' },
      { name: 'sma_50', type: 'DECIMAL(10,4)' },
      { name: 'sma_200', type: 'DECIMAL(10,4)' },
      { name: 'ema_20', type: 'DECIMAL(10,4)' },
      { name: 'technical_signal', type: 'VARCHAR(20)' },
      { name: 'technical_strength', type: 'INT' },
    ];

    // Phase 2: SEC, Dark Pool, Options columns
    const phase2Columns = [
      { name: 'sec_recent_filings', type: 'INT' },
      { name: 'sec_insider_buys', type: 'INT' },
      { name: 'sec_insider_sells', type: 'INT' },
      { name: 'sec_latest_8k_date', type: 'DATE' },
      { name: 'sec_signal', type: 'VARCHAR(20)' },
      { name: 'dark_pool_volume', type: 'BIGINT' },
      { name: 'dark_pool_pct', type: 'DECIMAL(5,2)' },
      { name: 'dark_pool_signal', type: 'VARCHAR(20)' },
      { name: 'options_call_volume', type: 'BIGINT' },
      { name: 'options_put_volume', type: 'BIGINT' },
      { name: 'options_call_put_ratio', type: 'DECIMAL(5,2)' },
      { name: 'options_unusual_activity', type: 'BOOLEAN' },
      { name: 'options_max_pain', type: 'DECIMAL(10,2)' },
      { name: 'options_signal', type: 'VARCHAR(20)' },
    ];

    const allColumns = [...technicalColumns, ...phase2Columns];

    for (const col of allColumns) {
      try {
        await client.query(`ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
        console.log(`  Added column: ${col.name}`);
      } catch (err: any) {
        if (err.code === '42701') {
          console.log(`  Column ${col.name} already exists`);
        } else {
          console.error(`  Error adding ${col.name}:`, err.message);
        }
      }
    }

    // Create indexes
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_scan_results_technical ON scan_results(technical_signal)',
      'CREATE INDEX IF NOT EXISTS idx_scan_results_options_signal ON scan_results(options_signal)',
      'CREATE INDEX IF NOT EXISTS idx_scan_results_sec_signal ON scan_results(sec_signal)',
    ];

    for (const idx of indexes) {
      try {
        await client.query(idx);
        console.log(`  Created index`);
      } catch (err: any) {
        console.log(`  Index may already exist:`, err.message);
      }
    }

    // Create alert_rules table
    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        enabled BOOLEAN DEFAULT true,
        alert_type VARCHAR(30) NOT NULL,
        conditions JSONB NOT NULL,
        channels TEXT[] NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('  Created alert_rules table');

    // Create classification_accuracy table
    await client.query(`
      CREATE TABLE IF NOT EXISTS classification_accuracy (
        id SERIAL PRIMARY KEY,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        classification VARCHAR(20) NOT NULL,
        total_picks INT NOT NULL DEFAULT 0,
        winners_1d INT NOT NULL DEFAULT 0,
        winners_3d INT NOT NULL DEFAULT 0,
        winners_5d INT NOT NULL DEFAULT 0,
        losers INT NOT NULL DEFAULT 0,
        avg_return_1d DECIMAL(8,2),
        avg_return_3d DECIMAL(8,2),
        avg_return_5d DECIMAL(8,2),
        avg_max_gain DECIMAL(8,2),
        avg_max_drawdown DECIMAL(8,2),
        win_rate_1d DECIMAL(5,2),
        win_rate_5d DECIMAL(5,2),
        sharpe_ratio DECIMAL(5,2),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT unique_period_classification UNIQUE (period_start, period_end, classification)
      )
    `);
    console.log('  Created classification_accuracy table');

    console.log('\nMigration completed successfully!');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(console.error);
