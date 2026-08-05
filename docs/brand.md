# eComGear Brand

This doc separates what's **verified from actual code/copy** in this repo from anything **inferred**. No section states a value that isn't traceable to a file.

## Positioning (verified — real landing page copy)

Source: `src/components/landing/HeroSection.tsx:11-15`

> **H1:** "Hire an Agent, Not an Agency."
> **Subhead:** "Ecomgear is the autonomous operator for small businesses going global. One prompt and an agent ships your storefront to the world and to China, at the same time."
> **Primary CTA:** "Launch with an agent"

Footer CTA, `src/components/landing/FooterCTA.tsx:48-49`: "Ready to sell **everywhere?**" / "Get early access".

`README.md:1-11`: "AI-powered website generation platform" — "lets users describe a website/app in natural language" then generates, previews, and iterates on it.

**Inferred from the above (not a documented mission statement — no such doc exists in this repo):** the pitch is agent-does-the-work-for-you positioning aimed at small businesses wanting a storefront live in both Western and Chinese markets simultaneously ("to the world and to China"). Treat this as copy-derived, not brand doctrine.

No target-audience doc, tone-of-voice guide, or mission statement exists anywhere in `docs/`. `docs/llm-platform-complete-design-guide.md` and `docs/ui-ux-implementation-pack.md` are both technical (architecture, UI implementation) — neither contains brand/positioning material.

## Visual identity (verified — `src/index.css:1-40`, `tailwind.config.ts:108-114`)

**Fonts** — declared via Google Fonts import (`src/index.css:1`) and mapped to Tailwind utilities (`tailwind.config.ts:110-113`):
- Display: **Fraunces** (serif, weights 600/700) — `font-display`
- Body: **Manrope** (sans-serif, weights 400-700) — `font-body`

**Color tokens** (HSL triplets, dark theme, `:root` in `src/index.css:9-31`):

| Token | HSL | Role |
|---|---|---|
| `--background` | `210 30% 12%` | Base dark navy |
| `--foreground` | `210 20% 98%` | Near-white text |
| `--primary` | `180 95% 45%` | Cyan/teal — main accent |
| `--primary-glow` | `180 100% 60%` | Brighter cyan for glow effects |
| `--secondary` | `30 100% 55%` | Orange |
| `--accent` | `280 85% 60%` | Purple |
| `--trigger` | `286 87% 49%` | Magenta-purple |
| `--destructive` | `0 84.2% 60.2%` | Red |

Gradients built from these tokens: `--gradient-primary` (cyan → light blue), `--gradient-accent` (cyan → purple), `--gradient-orange` (orange range), `--gradient-hero` (dark navy range). `--shadow-glow`/`--shadow-glow-accent`/`--shadow-elegant` all key off `--primary`/`--accent` at low opacity.

Note: `src/base-example/src/index.css` defines a **different** light-theme token set (`--background: 0 0% 100%`, `--primary: 234 60% 25%` — indigo, not cyan). That file is a scaffold/template for AI-generated user projects, not this app's own theme — don't confuse the two when reading `index.css` search results.

**Logo assets** (`src/assets/`, verified present, no usage audit performed):
- `ecomgear-logo.png`, `ecomgear-logo.jpg` — primary logo
- `ecomgear-icon.jpg` — icon/favicon-style mark
- `ecomgear-auth-logo.png` — auth-page variant
- `ecg-logo.png`, `ecgagent.png` — additional/agent-branded marks
- `hero-background.png` — landing hero background image
- `wechat-logo.png` — WeChat integration icon (consistent with the "to China" positioning above)

## Design principles

No documented design-principles doc found (`docs/ui-ux-implementation-pack.md` covers implementation patterns/components, not principle-level rationale). Not fabricated here.

## What was deliberately left out

- No stated brand voice/personality (playful vs. formal, etc.) — not documented anywhere, not guessed.
- No stated target-audience demographic beyond "small businesses going global" (verbatim from hero copy).
- No color-meaning rationale (why cyan = primary, why orange = secondary) — tokens are verified, their symbolic intent is not documented and isn't guessed here.
- Landing page has multiple variants (`src/components/landing/` and `src/components/landing-v2/`) — this doc only verified copy from the `landing/` (v1) `HeroSection.tsx`; `landing-v2` was not audited for copy differences.
