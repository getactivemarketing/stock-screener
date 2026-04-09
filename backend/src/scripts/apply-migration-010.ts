import 'dotenv/config';
import { readFileSync } from 'fs';
import path from 'path';
import db from '../db/index.js';

async function main() {
  const sqlPath = path.resolve(process.cwd(), '../database/migration-010-scan-results-unified.sql');
  const sql = readFileSync(sqlPath, 'utf-8');
  await db.query(sql);
  console.log('Migration 010 applied OK');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
