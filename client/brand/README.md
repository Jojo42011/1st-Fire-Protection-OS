# Northstar Fire & Safety — Brand Kit

The reusable visual identity for Northstar Fire & Safety materials. Point any new
page, doc, or deck at these tokens so everything stays consistent.

- `brand.css` — design tokens (CSS custom properties) + decorative components
- `fonts/` — Inter (400/700/900) and JetBrains Mono (500), latin subset `.woff2`
- `logo.png` — the round NFS/Texas emblem. Served at `/brand/logo.png` and used
  as the app favicon and the sidebar brand mark in `client/shell.html`. Keep it a
  PNG (do not convert to SVG). Drop a replacement at this exact path to swap it;
  no code changes needed. Until the file exists the sidebar falls back to the
  "NFS" gradient badge.

## Overall feel

Authoritative, industrial, and urgent — like walking into a fire station's
command center. Technical expertise, reliability, and a "we mean business"
attitude. Built for facility managers, property owners, and businesses that
take safety seriously — a professional trade partner, not a consumer brand.

## Color palette

| Role | Token | Hex | Meaning / use |
|---|---|---|---|
| Primary red — *the fire* | `--fp-red` | `#E53935` | CTAs, icons, borders, accent/signal lines. The emotional heartbeat. Aggressive, urgent, impossible to ignore. |
| Red (deep) | `--fp-red-deep` | `#C62828` | Hover/pressed state for red. |
| Red (tint) | `--fp-red-tint` | `#FCE9E8` | Critical-path fills behind red. |
| Secondary navy — *the uniform* | `--fp-navy` | `#1E2D40` | Dark section backgrounds, nav bar, footer. Authority, structure, trust. |
| Off-white — *the blueprint* | `--fp-paper` | `#F5F7F9` | Page background. Clean, technical; gives red + navy room to breathe. |
| Panel | `--fp-panel` | `#FFFFFF` | Cards on the paper ground. |
| Accent gold — *the badge* | `--fp-gold` | `#F5B81B` | Certification, excellence, earned recognition. Used sparingly. |
| Gold (deep) | `--fp-gold-deep` | `#B9860C` | Gold text/borders that need contrast on light. |

Neutrals (`--fp-ink`, `--fp-muted`, `--fp-line`) are navy-biased, never pure grey.

## Typography

**All Inter**, a clean geometric sans.

- Headings: **weight 900 (font-black)**, uppercase, tight tracking — every section
  title reads like a stamped metal sign. Use `.fp-display`.
- Body: weight 400, generous and readable.
- **JetBrains Mono (500)** for technical/engineering touches — labels, phone
  numbers, area codes, index tags, corner-cross detailing. Use `.fp-mono`.

## Decorative language

Borrowed from engineering drawings, floor plans, and equipment schematics —
"we design systems, not just sell products":

- **Blueprint grid** background — `.fp-blueprint` on `<body>` or a section.
- **Thin red signal lines** as section dividers — `.fp-signal`.
- **Technical corner-cross frames** on bordered elements — `.fp-frame`
  (adds red `+` markers at all four corners).

## Quick start

```html
<link rel="stylesheet" href="/brand/brand.css">

<body class="fp-blueprint">
  <p class="fp-kicker">Call Routing System</p>
  <h1 class="fp-display" style="font-size:56px">One agent, nine front doors</h1>
  <div class="fp-signal"></div>

  <section class="fp-frame" style="border:1.5px solid var(--fp-navy);padding:26px">
    <span class="fp-badge">Certified</span>
    <a class="fp-btn" href="#">Request service</a>
  </section>
</body>
```

## Self-contained exports

`brand.css` loads fonts by relative path (`fonts/*.woff2`), which is right for the
website and any multi-file project. For a **single** portable HTML file (email,
one-off export, a Claude Artifact — external URLs are blocked there), inline the
faces instead: base64-encode each `.woff2` and swap the `src:` for a
`url(data:font/woff2;base64,…)`. The routing schematic at
`ai-projects/ai-receptionist/06-routing-schematic.html` is built that way and is a
working reference.

## Component reference (`brand.css`)

| Class | Purpose |
|---|---|
| `.fp-blueprint` | Blueprint-grid paper ground |
| `.fp-display` | Font-black uppercase heading (stamped-sign) |
| `.fp-kicker` | Mono eyebrow with red lead rule |
| `.fp-mono` | JetBrains Mono technical text |
| `.fp-signal` | Thin red signal-line divider |
| `.fp-frame` | Corner-cross technical frame |
| `.fp-badge` | Gold certification badge |
| `.fp-btn` / `.fp-btn--ghost` | Red CTA / outlined navy button |
| `.fp-panel-navy` | Dark "uniform" panel |
