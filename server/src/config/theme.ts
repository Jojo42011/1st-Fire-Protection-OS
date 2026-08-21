/**
 * Brand theme: the single source of truth for colors, mirrored in client/theme.css and the shell.
 * The 1st Fire Protection system is subtractive: ink carries the interface, ember is identity only
 * (never a status color or an email button), gold marks credentials, off-white is the ground.
 */
export const THEME = {
  // Off-white paper: the page ground
  paper: '#FAFAFA',
  panel: '#FFFFFF',
  // Ink: primary type, buttons, nav, dark bands, active states
  navy: '#101828',
  navy2: '#1A2233',
  navyLine: '#1F2637',
  // Ink + neutrals
  ink: '#101828',
  muted: '#667085',
  line: '#E4E7EC',
  line2: '#98A2B3',
  // Ember: brand accent, identity only, never a button in email
  red: '#C0362B',
  redDeep: '#A32B22',
  redTint: '#F9EAE8',
  // Gold: credentials, licenses, certifications (#8A6A2F when set on white)
  gold: '#A8823C',
  goldDeep: '#8A6A2F',
  ok: '#12805C',
  // Type
  sans: "'Geist','Helvetica Neue',Helvetica,Arial,sans-serif",
  mono: "'Geist Mono',ui-monospace,Consolas,'Courier New',monospace",
};
