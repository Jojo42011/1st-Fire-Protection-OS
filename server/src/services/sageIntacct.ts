import { getState, setState } from '../db/schema';

/**
 * The Sage Intacct client — the connector that will make the Invoice Collector real. Sage
 * Intacct is the authoritative A/R source, so once connected the Collector chases real
 * receivables instead of the ServiceTrade balance enrichment.
 *
 * Same SAFETY DOCTRINE as ServiceTrade: one request path, and any write (create/update/delete)
 * is HARD-BLOCKED unless the mode is 'read_write'. Mode defaults to 'read_only'. Keyless-safe:
 * no credentials → not connected, everything throws a typed error the callers tolerate.
 *
 * Intacct's API is a session-based XML gateway (not REST): a <request> envelope carries the
 * web-services sender credentials plus a company login, and functions (readByQuery, etc.) run
 * inside it. This module builds that envelope; A/R reads and the Collector wiring land once real
 * credentials exist (this is the scaffold, untested against the live gateway until then).
 */

const IA_URL = process.env.INTACCT_URL || 'https://api.intacct.com/ia/xml/xmlgw.phtml';
const MODE_KEY = 'intacct_sync_mode';
export type IntacctMode = 'read_only' | 'read_write';

/** All five web-services + company-login credentials present? */
export function intacctConfigured(): boolean {
  return !!(
    process.env.INTACCT_SENDER_ID &&
    process.env.INTACCT_SENDER_PASSWORD &&
    process.env.INTACCT_COMPANY_ID &&
    process.env.INTACCT_USER_ID &&
    process.env.INTACCT_USER_PASSWORD
  );
}

export function getIntacctMode(): IntacctMode {
  return getState(MODE_KEY) === 'read_write' ? 'read_write' : 'read_only';
}
export function setIntacctMode(mode: IntacctMode): IntacctMode {
  const next: IntacctMode = mode === 'read_write' ? 'read_write' : 'read_only';
  setState(MODE_KEY, next);
  return next;
}
export function intacctCanWrite(): boolean {
  return getIntacctMode() === 'read_write';
}

export class IntacctNotConnectedError extends Error {
  constructor() { super('Sage Intacct is not connected (no credentials configured)'); this.name = 'IntacctNotConnectedError'; }
}
export class IntacctReadOnlyError extends Error {
  constructor(fn: string) {
    super(`Blocked ${fn}: Sage Intacct is in read-only mode. Flip the mode to "write" in Settings to allow changes.`);
    this.name = 'IntacctReadOnlyError';
  }
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Function names that mutate Intacct data — the ones the read-only gate refuses.
const WRITE_FN = /^(create|update|delete|upsert|reverse|post|void)/i;

/**
 * Run one Intacct function inside an authenticated envelope. GET-like reads (readByQuery, read,
 * inspect…) are always allowed; a mutating function is refused unless mode is read_write —
 * before any request goes out. Returns the raw XML response text (parsing lands with the AR work).
 */
export async function intacctCall(fnName: string, innerXml: string): Promise<string> {
  if (!intacctConfigured()) throw new IntacctNotConnectedError();
  if (WRITE_FN.test(fnName) && !intacctCanWrite()) throw new IntacctReadOnlyError(fnName);

  const controlId = 'ctl-' + fnName;
  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<request><control>` +
    `<senderid>${xmlEscape(process.env.INTACCT_SENDER_ID || '')}</senderid>` +
    `<password>${xmlEscape(process.env.INTACCT_SENDER_PASSWORD || '')}</password>` +
    `<controlid>${controlId}</controlid><uniqueid>false</uniqueid><dtdversion>3.0</dtdversion>` +
    `</control><operation><authentication><login>` +
    `<userid>${xmlEscape(process.env.INTACCT_USER_ID || '')}</userid>` +
    `<companyid>${xmlEscape(process.env.INTACCT_COMPANY_ID || '')}</companyid>` +
    `<password>${xmlEscape(process.env.INTACCT_USER_PASSWORD || '')}</password>` +
    `</login></authentication><content>` +
    `<function controlid="f1">${innerXml}</function>` +
    `</content></operation></request>`;

  const res = await fetch(IA_URL, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: envelope });
  if (!res.ok) throw new Error(`Sage Intacct HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (/<status>\s*failure\s*<\/status>/i.test(text)) {
    const err = /<description2?>([^<]+)<\/description2?>/i.exec(text);
    throw new Error(`Sage Intacct: ${err ? err[1] : 'request failed'}`);
  }
  return text;
}

/** Harmless connection test: opens a session (getAPISession). Never writes. */
export async function testConnection(): Promise<{ ok: boolean; detail: string }> {
  if (!intacctConfigured()) return { ok: false, detail: 'No Sage Intacct credentials set.' };
  try {
    await intacctCall('getAPISession', '<getAPISession/>');
    return { ok: true, detail: 'Connected to Sage Intacct.' };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/* ─────────────────────────── read-only queries (scaffold) ───────────────────────────
 * readByQuery + a tolerant parser for Intacct's XML records, so the OS can pull data once a
 * developer-license sender ID + web-services user are provisioned (set the INTACCT_* env vars).
 * Read-only: readByQuery is a GET-like function, never blocked by the write gate. Untested against
 * the live gateway until real credentials exist. */

/** Parse the record blocks out of a readByQuery response into flat objects (leaf tag -> text). */
function parseRecords(xml: string, object: string): Record<string, string>[] {
  const dataM = /<data[^>]*>([\s\S]*?)<\/data>/i.exec(xml);
  if (!dataM) return [];
  const inner = dataM[1];
  // The record element is the object name Intacct echoes back (case can vary); detect the first child.
  const tagM = new RegExp(`<(${object}|${object.toLowerCase()}|[A-Za-z0-9_]+)>`, 'i').exec(inner);
  const tag = tagM ? tagM[1] : object;
  const recRe = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out: Record<string, string>[] = [];
  let m: RegExpExecArray | null;
  while ((m = recRe.exec(inner))) {
    const rec: Record<string, string> = {};
    const leafRe = /<([A-Za-z0-9_]+)>([^<]*)<\/\1>/g;
    let f: RegExpExecArray | null;
    while ((f = leafRe.exec(m[1]))) if (!(f[1] in rec)) rec[f[1]] = f[2];
    out.push(rec);
  }
  return out;
}

/** Run a readByQuery and return parsed records. Bounded to one page (pagesize) for now. */
export async function intacctReadByQuery(object: string, fields: string[], query = '', pagesize = 1000): Promise<Record<string, string>[]> {
  const inner =
    `<readByQuery><object>${xmlEscape(object)}</object>` +
    `<fields>${xmlEscape(fields.join(','))}</fields>` +
    `<query>${xmlEscape(query)}</query>` +
    `<pagesize>${pagesize}</pagesize></readByQuery>`;
  const xml = await intacctCall('readByQuery', inner);
  return parseRecords(xml, object);
}

export interface SageUser { loginId: string | null; name: string | null; email: string | null; type: string | null; status: string | null }

/** Pull the Sage Intacct user list (for the license-reclaim report). Keyless-safe. */
export async function listSageUsers(): Promise<{ ok: boolean; error?: string; users: SageUser[] }> {
  if (!intacctConfigured()) return { ok: false, error: 'Sage Intacct is not connected', users: [] };
  try {
    const rows = await intacctReadByQuery('USERINFO', ['RECORDNO', 'LOGINID', 'USERTYPE', 'STATUS', 'CONTACTINFO.EMAIL1', 'CONTACTINFO.CONTACTNAME']);
    const users = rows.map((r) => ({
      loginId: r.LOGINID || null,
      name: r.CONTACTNAME || null,
      email: r.EMAIL1 || null,
      type: r.USERTYPE || null,
      status: r.STATUS || null,
    }));
    return { ok: true, users };
  } catch (err) {
    return { ok: false, error: (err as Error).message, users: [] };
  }
}
