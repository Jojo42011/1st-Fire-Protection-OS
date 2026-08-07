/**
 * DEMO_MODE kill-switch. ON by default (DEMO_MODE !== 'off').
 *
 * Imported as the VERY FIRST line of app.ts, before anything else reads env or opens the db.
 * It neutralizes the running instance without deleting any integration code (fully reversible):
 *   1. Deletes every external-connection credential from process.env, so all isConnected()
 *      checks go false and the whole app runs keyless on seeded data.
 *   2. Redirects the SQLite path to a separate demo file (1stfp-demo.db on the same volume), so a
 *      live deploy serves a FRESH dummy db and never touches the real one.
 *   3. Logs a one-line banner.
 * Set DEMO_MODE=off to restore live behavior.
 */
import path from 'path';

const DEMO = process.env.DEMO_MODE !== 'off';

/** Every external-connection credential/endpoint. Stripped in demo so nothing can dial out. */
const SECRET_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MOONSHOT_API_KEY', 'VAPI_API_KEY', 'VAPI_SERVER_SECRET',
  'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER', 'SERVICETRADE_CLIENT_ID', 'SERVICETRADE_CLIENT_SECRET', 'SERVICETRADE_TOKEN',
  'SERVICETRADE_USERNAME', 'SERVICETRADE_PASSWORD', 'SERVICETRADE_WEBHOOK_SECRET', 'INTACCT_SENDER_ID',
  'INTACCT_SENDER_PASSWORD', 'INTACCT_COMPANY_ID', 'INTACCT_USER_ID', 'INTACCT_USER_PASSWORD',
  'MS365_TOKEN', 'N8N_API_KEY', 'MS_MAIL_FROM', 'STRIPE_API_KEY', 'GOOGLE_BUSINESS_TOKEN',
  'FACEBOOK_PAGE_TOKEN', 'GMAIL_ACCESS_TOKEN', 'BAMBOO_SUBDOMAIN', 'BAMBOO_API_KEY', 'MS_GRAPH_TOKEN',
  'MS_GRAPH_TENANT', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET', 'ADOBE_UMAPI_TOKEN',
  'AUTODESK_TOKEN', 'BLUEBEAM_API_KEY', 'HYDRACAD_API_KEY', 'HFSS_API_KEY', 'AIOS_REPORT_KEY',
  'AIOS_REPORT_URL', 'PARTNER_KEY', 'PARTNER_VDS_URL', 'INTROSPECT_TOKEN',
];

if (DEMO) {
  let stripped = 0;
  for (const k of SECRET_KEYS) {
    if (process.env[k] != null) {
      delete process.env[k];
      stripped++;
    }
  }
  // Point the app at a fresh, separate demo database on the same volume. The real db file is
  // never opened, so a live deploy cannot read or mutate real company data.
  const real = process.env.DB_PATH || path.join(process.cwd(), 'data', '1stfp.db');
  process.env.DB_PATH = path.join(path.dirname(real), '1stfp-demo.db');
  console.log(
    `[DEMO_MODE] ON: stripped ${stripped} external credentials, db redirected to ${process.env.DB_PATH}. Set DEMO_MODE=off to restore live.`
  );
} else {
  console.log('[DEMO_MODE] off: live integrations enabled.');
}

export const DEMO_MODE = DEMO;
