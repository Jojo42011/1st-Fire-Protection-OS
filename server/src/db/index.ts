import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { canonicalOffice } from '../os/office';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'northstardemo.db');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  // os_office_key(x): canonical office key for any office string, so office scope can be enforced
  // inside SQL (WHERE os_office_key(office) IN (...)) instead of filtering rows in application code.
  _db.function('os_office_key', { deterministic: true }, (x: any) => canonicalOffice(x == null ? '' : String(x)));
  return _db;
}
