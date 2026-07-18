import { buildIntrospectionSnapshot } from './introspection';

/**
 * Daily push report to Booker Growth OS — the same metadata-only snapshot the
 * /api/introspect endpoint serves, POSTed once a day.
 *
 * Configured entirely by env: AIOS_REPORT_URL + AIOS_REPORT_KEY. If either is unset the
 * job silently does nothing. Failures never affect the app — log and move on.
 */
export async function sendAiosReport(): Promise<void> {
  const url = process.env.AIOS_REPORT_URL;
  const key = process.env.AIOS_REPORT_KEY;
  if (!url || !key) return; // reporting not configured — silent no-op

  try {
    const snapshot = buildIntrospectionSnapshot();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aios-key': key },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      console.log('[aios-report] daily snapshot delivered');
    } else {
      console.warn(`[aios-report] delivery failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn('[aios-report] delivery failed:', (err as Error).message);
  }
}
