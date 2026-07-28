# Design — eCG Agent Dashboard

A locked design system for this app. Every page redesign reads this file before
emitting code. Do not regenerate per page — extend or amend this file when the
system needs to grow. Written under the Hallmark design skill (full-teardown
redesign, `redesign` verb, multi-page flow).

## Genre

modern-minimal (Stripe / Linear / ElevenLabs school). Restrained, one brand
accent, no decorative flourish — the product's own capability is the substance.

## Why there is no "macrostructure" here

Hallmark's 21 named macrostructures (Bento Grid, Marquee Hero, Stat-Led, …) are
landing-page shapes — hero → proof → pricing → footer. This is an authenticated,
multi-page dashboard app; forcing a landing-page shape onto a Settings screen
would be a category error. The macrostructure concept is replaced with **page-type
templates** below — composition families for the actual screen types a SaaS
dashboard has, unified by one token system so 14+ pages read as one product.

## Page-type template family

- **List/Grid** (`AgentsPage`, `ConnectorsPage`, `RunsPage`, `KnowledgePage`) —
  card-grid composition built on `StatCard`/`EmptyState`; real hierarchy between
  a card's identity, status, and metadata rows; consistent icon-chip language.
- **Detail/Editor** (`AgentDetailPage`, `EditAgentPage`, `VisualEditorPage`) —
  identity header block (avatar/name/status inline) + sectioned content below,
  never an undifferentiated stack of same-weight cards.
- **Wizard** (`CreateAgentPage`) — persistent left step-rail showing all steps +
  current position, not just a bare top progress bar. Each step's content area
  is the same width/alignment across steps so nothing jumps.
- **Calendar/Content** (`PostsCalendarPage`, `PostsPage`) — day-cell + platform-pill
  language with real visual weight (color-coded by platform, today marked,
  overflow handled), not a default HTML-table feel.
- **Settings** (`SettingsPage`) — label + one-line description on the left,
  the control on the right, one setting per row, grouped under section headers.
- **Home/Command-center** (`DashboardPage`) — KPI row reads as the dominant
  element (via the type scale + StatCard's accent bar), activity feed and side
  rail are clearly subordinate to it, not equal-weight siblings.

## Theme — parametric, not catalog (the one hard constraint)

Each generated dashboard gets its OWN palette from two inputs an org chooses at
creation time: a theme preset key (`light | dark | ocean | forest | sunset |
slate`, `THEME_DEFAULTS` in `server/src/services/ecg-template.ts`) and an
optional custom accent hex. `cssVars()` derives every other color from those two
inputs using real OKLCH math (`hexToOklch`/`oklchToHex`/`oklchShift`/
`tintedNeutral` in the same file) — perceptually uniform lightness shifts for
hover/darker variants (never the old sRGB channel-subtract, which desaturates
saturated accents), and a "living neutral" ink/border/card scale carrying a
whisper of the accent's hue (chroma ≈0.006) instead of a flat hue-less gray.

This file does not hardcode a palette — it documents the SYSTEM that generates
one per org. Do not add a 7th static theme here; add it to `THEME_DEFAULTS`.

### Token roles (emitted by `cssVars()`, consumed everywhere as `var(--x)`)

- `--accent`, `--accent-hover`, `--accent-bg`, `--accent-bg-hover`, `--accent-rgb`
- `--sidebar-bg`, `--sidebar-text`, `--sidebar-muted`, `--sidebar-hover`
- `--body-bg`, `--card-bg`, `--input-bg`, `--border`
- Ink scale: `--ink-1` (primary text) → `--ink-4` (disabled/placeholder);
  `--text`/`--muted` remain aliases (`--ink-1`/`--ink-3`) for every existing
  component already written against those two names
- Status (reserved, brand-independent, never theme-derived): `--success`,
  `--warning`, `--danger` + each `-bg` tint
- `--radius-sm` (8px) / `--radius` (12px) / `--radius-lg` (16px) / `--radius-full`
- `--shadow-sm` / `--shadow-md` / `--shadow-lg` / `--shadow-accent`

## Typography

- Display: Space Grotesk 600, headings only (`h1`/`h2`/`h3`, `-0.01em` tracking)
- Body: the org's chosen `fontFamily` (default Inter), 400/500 weight
- Scale (all emitted as tokens, never a raw Tailwind `text-*` pick in new work):
  `--text-tiny` 11px · `--text-small` 13px · `--text-body` 15px · `--text-lg` 17px
  · `--text-h3` 20px · `--text-h2` 26px · `--text-h1` 32px · `--text-display` 40px
- Line-height: `--leading-tight` 1.2 (headings) / `--leading-normal` 1.5 (body) /
  `--leading-relaxed` 1.6 (long-form)
- Tracking: `--tracking-tight` −0.01em (display) / `--tracking-normal` / `--tracking-wide` 0.02em (eyebrows/labels)

## Spacing

4pt scale, named tokens `--space-1` (4px) through `--space-16` (64px). New
component work references these, not raw Tailwind spacing utilities, so the
rhythm stays consistent as pages get touched independently over time.

## Motion

- Easings: `--ease-out` (entrances), `--ease-in` (exits), `--ease-in-out`
  (state changes) — never the browser default `ease`
- Durations: `--duration-fast` 120ms (hover/press) · `--duration-base` 180ms
  (content transitions) · `--duration-slow` 280ms (larger reveals)
- Reveal pattern: one subtle fade-rise on page mount (already in `index.css`),
  nothing more per page — this is a working tool, not a marketing site
- `prefers-reduced-motion: reduce` collapses every transition to an instant
  or ≤120ms opacity-only change

## Microinteractions stance

- Silent success over celebratory toasts (an approved post just leaves the list)
- Buttons: `:focus-visible` ring always present, shown instantly (never animated
  in), ≥3:1 contrast against its surface
- Disabled state: `opacity: 0.5` + `cursor: not-allowed`, never hidden entirely
- Loading: inline spinner or skeleton, never a full-page blocking overlay for
  anything already-rendered content can stay visible during

## CTA voice

- Primary action: solid `--accent` fill, white text, `--radius` (12px), one per view
- Secondary action: outline/ghost, `--border` or `--muted` text
- Destructive action: `--danger` text/fill, always confirmed via a modal
  (`AgentDeleteModal` pattern) before an irreversible action fires

## What pages MUST share

- The token set above (colors, spacing, type scale, motion) — zero exceptions
- The sidebar nav (N3 side-rail archetype) and its Content/System grouping
- The agent switcher when `ECG.agentIds.length > 1`
- `PageHeader`/`Card`/`EmptyState`/`SectionHeader` for their respective jobs —
  no page hand-rolls a replacement for a primitive that already exists

## What pages MAY differ on

- Which page-type template they follow (a list page composes differently from
  a wizard page — that's the intended variety, not drift)
- Whether `showSummaryCards`/specific modules are shown, per `ECG.modules`

## Exports

### tokens.css

See `cssVars()` in `server/src/services/ecg-template.ts` — the canonical token
block is generated per-org at seed time (2 inputs: theme key + accent hex), not
a static file. There is no fixed `tokens.css` to export since the values are
parametric; the *token names* above are the stable contract every component
codes against.
