import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/index';
import { setState } from '../db/schema';

/**
 * Optional encrypted off-Fly backup export. DISABLED by default: it does nothing unless BOTH
 * BACKUP_UPLOAD_URL (a presigned PUT destination, e.g. S3/GCS) and BACKUP_ENCRYPTION_KEY are set as
 * environment secrets. It takes a consistent SQLite snapshot, encrypts it with AES-256-GCM, uploads the
 * ciphertext, and verifies the upload responded 2xx before recording success. Secrets are never logged.
 *
 * This gives an off-machine recovery path beyond Fly's short-retention volume snapshots, without wiring
 * any external destination into the app unless the operator explicitly configures one.
 */

export function offFlyConfigured(): boolean {
  return !!(process.env.BACKUP_UPLOAD_URL && process.env.BACKUP_ENCRYPTION_KEY);
}

/** AES-256-GCM encrypt. Output layout: [iv(12)][authTag(16)][ciphertext]. Key derived via scrypt. */
export function encryptBuffer(plain: Buffer, passphrase: string): Buffer {
  const salt = Buffer.from('1stfp-os-backup-v1'); // fixed, non-secret domain separator
  const key = crypto.scryptSync(passphrase, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

/** Inverse of encryptBuffer (used by the restore-drill tooling and tests). */
export function decryptBuffer(blob: Buffer, passphrase: string): Buffer {
  const salt = Buffer.from('1stfp-os-backup-v1');
  const key = crypto.scryptSync(passphrase, salt, 32);
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/**
 * Run one off-Fly backup. No-op (skipped) unless configured. Never throws into the caller; returns a
 * structured result. On success records last_offfly_backup_at for the readiness screen.
 */
export async function runOffFlyBackup(): Promise<{ ok: boolean; skipped?: string; bytes?: number; error?: string }> {
  if (!offFlyConfigured()) return { ok: false, skipped: 'not_configured' };
  const url = process.env.BACKUP_UPLOAD_URL as string;
  const key = process.env.BACKUP_ENCRYPTION_KEY as string;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmp = path.join(os.tmpdir(), `offfly-${stamp}-${process.pid}.db`);
  const cleanup = () => fs.promises.unlink(tmp).catch(() => {});
  try {
    await getDb().backup(tmp); // consistent snapshot (folds WAL)
    const plain = await fs.promises.readFile(tmp);
    const blob = encryptBuffer(plain, key);
    const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(blob) });
    await cleanup();
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `upload failed (${res.status})` }; // no response body logged (may echo a signed URL)
    }
    setState('last_offfly_backup_at', new Date().toISOString());
    return { ok: true, bytes: blob.length };
  } catch (e) {
    await cleanup();
    return { ok: false, error: (e as Error).message };
  }
}
