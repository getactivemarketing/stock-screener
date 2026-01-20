import 'dotenv/config';
import db from './db/index.js';

async function main() {
  console.log('Stock Screener Backend');
  console.log('======================\n');

  // Health check
  const healthy = await db.healthCheck();
  if (healthy) {
    console.log('Database connection: OK');
  } else {
    console.log('Database connection: FAILED');
    process.exit(1);
  }

  console.log('\nAvailable commands:');
  console.log('  npm run pipeline    - Run the stock screener pipeline');
  console.log('  npm run db:migrate  - Run database migrations');
  console.log('  npm run dev         - Run in development mode with watch');

  await db.close();
}

main().catch(console.error);
