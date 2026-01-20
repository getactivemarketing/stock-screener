import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  console.log('Running database migration...');

  try {
    // Read schema file
    const schemaPath = path.join(__dirname, '../../../database/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');

    // Execute schema
    await db.query(schema);

    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

migrate();
