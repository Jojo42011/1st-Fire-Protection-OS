/**
 * Brand theme — the single source of truth for colors, echoed to every client page.
 * Change these and the whole app re-skins.
 */
export const THEME = {
  bg: '#101B33', // deepest navy — page background
  panel: '#1B2A48', // card / sidebar navy
  panel2: '#223255', // raised card
  text: '#FFFFFF', // headings — bold, uppercase, condensed
  muted: '#93A4C0', // blue-gray body text
  line: 'rgba(255,255,255,0.08)',
  line2: 'rgba(255,255,255,0.18)',
  accent: '#E23744', // FIRE RED — buttons, underlines, active
  accent2: '#FF5A66', // hover / gradient top
  ok: '#46C77E', // "online" / connected green
  warn: '#E8B23A',
  font: '"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif',
  display: '"Archivo","Anton",Impact,"Inter",sans-serif',
  mono: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace',
};

/** Rendered as a <style>:root{...}</style> block injected into every client page. */
export function themeCssVars(): string {
  return `:root{
  --bg:${THEME.bg};--panel:${THEME.panel};--panel-2:${THEME.panel2};--text:${THEME.text};
  --muted:${THEME.muted};--line:${THEME.line};--line-2:${THEME.line2};--accent:${THEME.accent};
  --accent-2:${THEME.accent2};--ok:${THEME.ok};--warn:${THEME.warn};
  --font:${THEME.font};--display:${THEME.display};--mono:${THEME.mono};
}`;
}
