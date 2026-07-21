# The Command Room design language (canonical UI/UX reference)

This is the UI/UX gold standard for this codebase, extracted from The Operator (`client/audit.html`)
and The Roster (`client/roster.html`). The shared implementation lives in `client/command.css`. When a
rule here conflicts with what a page does, this document wins. Vanilla HTML/CSS/JS only, no frameworks,
no build step, one self-contained file per page, zero third-party requests.

## 1. The soul (why the audit tab feels different)

1. The business is shown as one living system, not a list of features. The home view is a single
   radial wheel, the whole company at a glance. Detail views show a system assembling in real time as
   the owner talks. Never a grid of generic dashboard cards.
2. Color is meaning, and there are exactly three meanings: signal (a leak, a problem, the thing
   demanding attention), build (assembling, proposed, in progress), live (running, done, healthy). No
   fourth accent, ever. Everything else is ink on surface.
3. Cinema-dark for intelligence surfaces. Deep layered darks, a faint radial glow at the top, hairline
   borders instead of boxes, light used sparingly so the three meaning colors read like instrument
   lights.
4. Mono micro-labels are the chrome. Every section eyebrow, status, count, and unit is tiny uppercase
   monospace with wide letter-spacing. Content is the sans; chrome is the mono. This one habit carries
   most of the look.
5. The interface reacts to every input. Answer a question: an agent node lights up, a line turns gold,
   a counter ticks. Progress is physical and visible. Nothing the user does lands in a void.

## 2. Tokens (in `:root`, re-skin by changing only these)

```css
:root{
  --s0:#0C131D; --s1:#101927; --s2:#152134; --s3:#1B2A42;      /* surfaces, darkest to lightest */
  --ink:#E9EEF5; --ink-2:#8FA0B4; --ink-3:#5C6B7D;             /* ink scale */
  --hair:rgba(233,238,245,.08); --hair-2:rgba(233,238,245,.16);
  --signal:#E53935; --build:#F5B81B; --live:#2E9E5B;           /* the three meanings (red/gold/green) */
  --signal-soft:rgba(229,57,53,.5); --build-soft:rgba(245,184,27,.5); --live-soft:rgba(46,158,91,.5);
  --sans:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;
}
body{background:var(--s0);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;
  background-image:radial-gradient(1000px 480px at 50% -100px,rgba(229,57,53,.05),transparent 70%)}
.wrap{max-width:1080px;margin:0 auto;padding:40px 40px 90px}
```

## 3. Typography register

- Micro eyebrow (the workhorse): mono, 10px, weight 500, letter-spacing .24em, uppercase, color
  ink-3. Use it for every section label, status, hint, and unit. A section eyebrow gets an 18px
  signal-colored dash before it.
- Headers: heavy and tracked. Page title 15px / 900 / letter-spacing .14em uppercase; view titles
  24px / 900 / .06em uppercase. Small sizes, huge weight.
- Big numbers: 30 to 36px, weight 700 to 800, tight letter-spacing (-.02em), with units and
  denominators as `small` in muted ink ("2/3" with the /3 muted).
- Data, counts, timestamps, keys: always mono, always small, often uppercase.
- Body copy stays 13 to 15px, line-height 1.45 to 1.6, muted ink-2 for secondary text.

## 4. Layout rules

- One centered column, max-width 1080px. Generous vertical air: 70 to 80px between home sections,
  34 to 44px after the header.
- Hairlines, not boxes. Rows separate with `border-bottom:1px solid var(--hair)`. Panels that must be
  boxes use `background:var(--s1);border:1px solid var(--hair)` and SQUARE corners. No border-radius
  on rectangles (only dots and the wheel are round).
- No decorative shadows. Glow (`box-shadow:0 0 7px var(--x-soft)`) is reserved for the meaning dots,
  where it reads as an LED. Overlays may cast one functional shadow.
- Detail views are a split grid: `grid-template-columns:1fr 1.1fr;gap:44px`, right pane
  `position:sticky;top:24px`. Collapses to one column under 900px, sticky released.

## 5. Signature components

- The wheel (home): an SVG (viewBox 720x720) built in JS, one annular segment per department (fill s1,
  hover s2, 2.5px gap stroke in s0), each wearing its uppercase name, mapped % in mono, a thin
  signal-colored coverage arc along the outer rim (arc length = coverage %, animated), and up to four
  capability dots (build color, live color when running). Hub circle carries company name (micro), OS
  title (big), overall mapped % (huge). Segments keyboard-focusable (tabindex, role=button,
  Enter/Space). One micro hint line under it.
- Stats strip: centered flex row, 64px gaps, micro label over a 36px number. No boxes around them.
- Finding/leak rows: full-width rows, 7px severity dot (signal glowing / build / muted), one-line
  title in ink, right-aligned matched-capability chip (6px dot + mono uppercase name), hairline
  between rows, whole row hover s1, click expands a muted detail paragraph (max 70ch). Show 5, then a
  mono "Show all N" text button.
- Ghost button (the only button): transparent, 1px hair-2 border, uppercase bold 12px / .18em,
  padding 16px 40px; hover: signal border + 8% signal tint fill. One primary action per screen.
- The consult (left pane): one question at a time on a card (s1, hairline, 2px signal left border),
  question at 18px regular. Quick-answer chips under it (transparent, hairline border, hover build
  border). One borderless answer input on a hairline baseline that turns signal on focus-within, with
  a dictation mic (Web Speech, hidden when unsupported, .rec pulse while recording) and a
  signal-colored send arrow. A mono "Skip question" link. A running log of prior answers as hairline
  rows (answer bold, question muted).
- The assembly (right pane): an SVG network, the department core (circle, s2) center, agent nodes
  (150x44 rects) fanned on an arc above, the systems it plugs into as mono text anchors below.
  Hairlines connect core to nodes; when an agent activates the line goes build-soft and the node
  stroke goes build (live agents stroke live). Below: a readout panel with the department AI one-line
  role, agent rows (meaning dot, uppercase name, plain-words job, mono "LIVE NOW" or "~3W"), and a
  build line ("1 live, 2 of 3 assembled, ~5 weeks") with numbers big and words small.
- Full-screen overlay (the brief): fixed inset 0, s0 background, a 660px column, ghost Copy/Close
  buttons on top, markdown rendered with a tiny regex renderer (h1 huge black uppercase, h2 as
  signal-colored micro, hr as hairline). Esc closes. Label which engine produced the content.
- Status pill (header, right): 6px dot + micro label. Degraded mode: build dot, "Rules Engine". Full
  mode: live dot with glow, "Operator Brain". The app states its own capability honestly in the chrome.

## 6. Motion vocabulary (all of it)

- View enter: `rise` (opacity 0 + translateY(10px) to none), .45s cubic-bezier(.2,.7,.3,1). Re-trigger
  by removing the class, forcing reflow (`void el.offsetWidth`), re-adding.
- Row expansions: same rise at .3s. Hovers / state flips: transitions .15 to .2s; node and line
  activations .4s; the coverage arc .8s ease.
- `pulse` (opacity 1 to .35, 1.4 to 1.8s infinite) only for recording / attention dots.
- Respect reduced motion globally:
  `@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}`
- Never: parallax, bounces, spinners, skeleton shimmer on these surfaces, springs.

## 7. Interaction and UX rules

- One question at a time. Never a form. Chips prefill the input (still editable), Enter sends, skip is
  always available, every answer is logged visibly.
- Every input produces a visible system reaction within the same second: something lights, ticks, or
  grows. If the backend is slow or absent, react locally first.
- Esc walks backward (close overlay, then leave detail view for home). Back buttons are 40px square
  hairline ghosts with a left angle.
- Real button and input everywhere; keyboard parity for every pointer path, including SVG targets;
  aria-expanded on expanders; sensible aria-labels on SVGs.
- Copy is in the owner plain words, short, no jargon, no exclamation marks, no emoji anywhere in the
  UI. Confidence is quiet ("Department mapped.").
- Degrade honestly: no API key or endpoint means the surface still fully works on rules or sample data
  and says so in the status pill, never a broken or empty screen.

## 8. Register: where the dark command room applies

The command room register (dark, cinematic) is for the intelligence surfaces: the audit / Operator
tab, brain views, executive readouts. Daily-driver tabs (calls, invoices, reviews) may keep the app
light register but must adopt the shared vocabulary: the mono micro-labels, hairline separation, the
three-meaning dot system, chips, ghost buttons, the rise motion, and the react-to-every-input rule. Do
not invent a second visual language; there is one language with a dark room and a daylight room.

## 9. Hard constraints

- Vanilla HTML/CSS/JS only. No frameworks, no CDN, no build step, zero third-party requests. Fonts are
  system-stack or locally hosted brand fonts.
- Each page is one self-contained file; server endpoints are the only dependency, and every fetch has
  a working fallback.
- Never introduce a fourth accent color, rounded cards, decorative shadows, spinners, confirm dialogs,
  or emoji. When in doubt, remove ink instead of adding it.
