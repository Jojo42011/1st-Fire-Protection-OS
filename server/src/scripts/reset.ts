/**
 * CLI demo-DB reset — `npm run reset`.
 *
 * Ensures the schema exists, wipes all demo data, and re-seeds. Safe to run
 * against a fresh or an already-populated DB. Honors DB_PATH like the server, so
 * on Fly:  fly ssh console -C "cd /app && npm run reset"
 */
import { initDb } from '../db/schema';
import { resetDb } from '../db/reset';

initDb();
const result = resetDb();
console.log(`[reset] demo DB reset — ${result.cleared} rows cleared, sample data re-seeded.`);
