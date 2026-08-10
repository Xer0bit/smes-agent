# FT30 Media — UI/UX Design Documentation

A cross-border media platform for global press distribution, social media publishing, and lead management. Built for PR agencies and enterprise brands entering international markets.

---

## 1. Brand & Visual Identity

### Brand Voice
- **Tone:** Trustworthy, enterprise-grade, editorial. Feels closer to Bloomberg / Reuters than to a startup SaaS.
- **Personality:** Confident, understated, cross-cultural (English / 简体中文 / 繁體中文).
- **Positioning:** Premium concierge service ($699/mo) — not self-serve growth-hacky.

### Color System (semantic tokens, HSL)
Defined in `src/index.css` and consumed via Tailwind semantic classes only.

| Token | Value | Use |
|---|---|---|
| `--background` | `0 0% 100%` | App canvas |
| `--foreground` | `230 50% 15%` | Primary text (deep navy-black) |
| `--primary` | `234 60% 25%` | Brand navy — buttons, links, active states |
| `--primary-foreground` | `0 0% 100%` | Text on navy |
| `--muted` | `230 20% 96%` | Subtle surfaces |
| `--muted-foreground` | `230 15% 45%` | Secondary text |
| `--border` | `230 20% 90%` | Hairlines |
| `--sidebar-background` | `234 60% 25%` | Full navy sidebar |
| `--sidebar-accent` | `234 50% 30%` | Sidebar hover |
| `--surface-elevated` | `230 30% 97%` | Section bands |
| `--destructive` | `0 84% 60%` | Errors, deletes |

**Signature move:** The `text-gradient-gold` utility is intentionally *not* gold — it's a navy-to-lighter-navy gradient. This keeps headline emphasis on-brand rather than reaching for a stereotypical premium gold.

### Typography
- **Display / Headings:** Space Grotesk (400–700). Geometric, modern, slightly technical.
- **Body:** DM Sans (400–700). Neutral, high legibility, pairs cleanly with Space Grotesk.
- **Font utilities:** `font-display` and `font-body` — never inline font-family.

### Spacing, Radius, Shadow
- **Radius:** `--radius: 0.75rem` — soft, not pillowy. Cards `rounded-xl`, buttons `rounded-md`.
- **Shadows:** Minimal. `shadow-gold` = `0 8px 32px -8px hsl(234 60% 25% / 0.15)` — a diffuse navy glow, used on elevated cards.
- **Density:** Generous — max-width containers `max-w-6xl` on marketing, `max-w-4xl` on editorial sections; consistent `px-4` gutters.
- **Motion:** Restrained. Color transitions + accordion animations only. No parallax, no scroll-jacking.

---

## 2. Information Architecture

```text
/                           Marketing site (public)
/login                      Auth
/admin                      Dashboard (default)
  /brand                    Brand assets, tone of voice
  /press                    Press release composer + distribution
  /social                   Multi-platform social publisher
  /leads                    Lead capture / Google Sheet sync
  /settings                 Account + Billing (Stripe portal)
  /clients                  [super_admin] All client accounts
  /clients/:id              [super_admin] Per-client detail + billing
```

Two audiences share the same shell:
- **Client admin** → sees only their own workspace.
- **Super admin** → sees a client selector in the header and gets the `/clients` route.

---

## 3. Public Marketing Site (`/`)

A single scrolling landing page composed of stacked full-width sections. The rhythm alternates plain background with `bg-surface-elevated` bands to segment the story.

### Layout order
1. **Navbar** (fixed, glass): logo left → anchor links center → language switcher + Login + primary CTA right. Backdrop blur `backdrop-blur-xl` over `bg-background/80` gives it an editorial fixed-header feel.
2. **HeroSection**: Centered logo, oversized display headline with gradient accent, single supporting subtitle. Behind it: a soft `600×600` navy glow blob (`blur-[120px]`) — the only decorative shape in the site.
3. **MediaReachSection**: Proof / distribution reach.
4. **SocialMediaSection**: Multi-platform capability.
5. **LeadManagementSection**: Lead workflow.
6. **PricingSection**: Single tier — $699/mo, "Start Free Trial" CTA opens `OnboardingModal`.
7. **OnboardingSection**: 4-step numbered card grid (Verify → Connect → Publish → Support) on `bg-surface-elevated`. Each card = numbered circle + Lucide icon + title + short desc.
8. **Footer**: Logo + copyright. Minimal by design — nothing else competes with the CTA above.

### UX patterns
- **Localization** is first-class — the globe icon in the navbar swaps EN / 简中 / 繁中 and persists via `localStorage`. Every static string routes through `useTranslation`.
- **CTA discipline:** exactly one primary conversion path (Start Free Trial → OnboardingModal → Stripe Checkout $699 recurring, promo `ft30_888` zeros first month).

---

## 4. Auth (`/login`)

Single centered card. Logo at top wraps a link back to `ft30.fgvexpo.com`. Email/password only. All labels/errors localized. No visual noise — the page is a conversion funnel, not an experience.

---

## 5. Admin Shell (`/admin/*`)

### Layout
```text
┌───────────────┬──────────────────────────────────────────┐
│               │  ☰  Admin Dashboard - <Client Name>   ⌄ │  ← header (h-14)
│  [Navy        ├──────────────────────────────────────────┤
│   Sidebar]    │                                          │
│               │        Main content (bg-muted/30)        │
│  · Dashboard  │                                          │
│  · Brand      │                                          │
│  · Press      │                                          │
│  · Social     │                                          │
│  · Leads      │                                          │
│  · Settings   │                                          │
│  · Clients*   │                                          │
│               │                                          │
│  user@...     │                                          │
│  [Sign out]   │                                          │
└───────────────┴──────────────────────────────────────────┘
```

### Sidebar (`AdminSidebar`)
- **Full navy** (`--sidebar-background: 234 60% 25%`) — creates strong figure/ground against the near-white workspace.
- Collapsible to icon-only via `SidebarTrigger`. Icons from `lucide-react`, one per route.
- Active item: white text on `--sidebar-accent`, medium weight.
- Footer: truncated user email + Sign out ghost button.
- Super-admin gets an extra "Clients" item appended dynamically.

### Header
- Left: sidebar trigger + page title (`"Admin Dashboard - Synovate Technology"`).
- Right: `ClientSelector` (super admin only) — dropdown to scope the entire admin view to one client's data via `ClientContext`.

### Main
- `bg-muted/30` — differentiates workspace from the pure-white cards inside.
- All pages compose from shadcn primitives: `Card`, `Tabs`, `Dialog`, `Sheet`, `Table`, `Badge`, `Toast`.

---

## 6. Admin Pages

### Dashboard (`/admin`)
KPI overview — counts of press releases, scheduled posts, leads, connected accounts. Card grid on top, recent activity list below.

### Brand (`/admin/brand`)
Central place for brand assets, tone-of-voice notes, logo uploads. These feed the AI-assisted composer downstream.

### Press Releases (`/admin/press`)
- List view of releases (Table with status badges: Draft / Scheduled / Distributed).
- Editor uses `RichTextEditor` for body content.
- Distribution triggers invoice generation (`invoice-press-release` edge function).

### Social Media (`/admin/social`) — the crown jewel
The compose dialog was recently redesigned into a **two-column layout**:

```text
┌─── Sticky Header ─────────────────────────────────────┐
│  Account selector ▾            [ Platform Badge ]     │
├───────────────────────┬───────────────────────────────┤
│                       │  Platform Options             │
│  Content composer     │  (conditional fields:         │
│  (textarea + count)   │   location, hashtags, CTA,    │
│                       │   link, visibility, alt text) │
│  Media dropzone       │                               │
│  (drag/drop + grid    ├───────────────────────────────┤
│   of thumbnails)      │  Publishing                   │
│                       │  ○ Draft  ○ Scheduled         │
│                       │  Date/time picker             │
├───────────────────────┴───────────────────────────────┤
│              Sticky Footer  [Cancel] [Publish]        │
└───────────────────────────────────────────────────────┘
```

- Conditional fields driven by `platformConfig[platform].features` — an Instagram post shows location + hashtags + first-comment + alt text; a LinkedIn post shows visibility toggle.
- Storage: single JSONB `platform_data` column keyed by platform. See `.lovable/plan.md`.
- Post list uses card items with platform icon badges, status pill, scheduled time, and metadata chips (location, hashtag count).

### Leads (`/admin/leads`)
Table view of captured leads with Google Sheet sync via `fetch-google-sheet` edge function. Filter/search bar on top.

### Settings (`/admin/settings`)
Tabbed layout:
- **Profile** — email, password
- **Billing** — "Manage Payment & Subscription" button opens Stripe Customer Portal; if no customer exists, falls back to `create-checkout` for $699/mo signup.
- **Team** (super admin) — manage-users edge function.

### Clients (super admin only)
- **List:** table of all client orgs with plan status, health indicators.
- **Detail (`/admin/clients/:id`):** tabs for Overview / Users / **BillingTab** / MCP config.
  - `BillingTab` shows a "Payment Method" card with card brand + last4 + expiry when on file, or a warning "No payment info" state if the customer hasn't completed Stripe Checkout. Invoices listed below in a table.

---

## 7. Component Patterns

- **shadcn/ui** is the base primitive layer — every dialog, dropdown, tooltip, toast, sheet, table, tabs, card.
- **Toasts:** dual system — `@/components/ui/toaster` for imperative feedback + `sonner` for lightweight async notifications.
- **Forms:** react-hook-form + zod (implicit via shadcn Form patterns).
- **Data:** `@tanstack/react-query` for all Supabase reads; mutations invalidate query keys.
- **Icons:** `lucide-react` exclusively — never emoji, never mixed icon sets.
- **NavLink:** thin wrapper over react-router's NavLink to standardize active-class handling in the sidebar.

---

## 8. Interaction & Micro-UX Principles

1. **One primary action per surface.** Buttons default to `variant="ghost"`; only the CTA gets `variant="hero"` or default.
2. **Localized everything.** No hardcoded English strings in components — always `t("namespace.key")`.
3. **Optimistic feel, honest state.** Loading skeletons on tables, disabled buttons during mutations, toast on success/failure.
4. **Empty states are pages, not blanks.** Every list surface has an illustration/icon + one-liner + primary CTA to create the first record.
5. **Destructive actions guarded** by AlertDialog confirmation, especially org / client / user deletion (which cascades through related tables).
6. **Sticky headers & footers** inside long dialogs (Social composer) — the primary action never scrolls out of reach.
7. **Fixed navbar with blur** on marketing but no fixed header on `/admin` beyond the compact `h-14` bar — admins get more vertical workspace.

---

## 9. Responsive Behavior

- **Marketing:** Mobile-first stacking. Nav links hidden below `md`, CTAs and language switcher remain. Hero headline scales `text-5xl → text-7xl`.
- **Admin:** Sidebar collapses to icon rail on narrow viewports via `useSidebar` state. Tables shift to horizontal scroll containers. Dialogs become full-height sheets on mobile.

---

## 10. Accessibility

- Semantic HTML (single `<h1>` per page, proper landmarks).
- All interactive controls are shadcn primitives → Radix under the hood → full keyboard + ARIA support.
- Language switch changes `<html lang>` via i18next.
- Focus rings use `--ring: 234 60% 25%` — visible on the light background.
- Alt text required in the social composer's media step (per-platform, stored in `platform_data`).

---

## 11. Design Anti-Patterns Explicitly Avoided

- ❌ Purple/indigo gradients on white (generic AI SaaS).
- ❌ Default Inter/Poppins pairing.
- ❌ Hardcoded color utilities (`text-white`, `bg-black`, hex classes) in components.
- ❌ Emoji as UI language.
- ❌ Multi-tier pricing page with feature comparison tables — pricing is a single conviction: $699/mo.
- ❌ Sidebar with light background — the navy sidebar is a deliberate anchor.

---

## 12. Tech Foundation Snapshot

- **Framework:** React 18 + Vite 5 + TypeScript 5
- **Styling:** Tailwind CSS v3 with semantic HSL tokens
- **UI Kit:** shadcn/ui (Radix primitives)
- **Routing:** react-router-dom v6
- **State/Data:** @tanstack/react-query + Supabase JS
- **Auth & DB:** External Supabase project (RLS-enforced, role separation via `user_roles` + `has_role()`)
- **Payments:** Stripe (live mode, $699/mo recurring, promo `ft30_888`)
- **i18n:** i18next + browser-languagedetector, three locales
- **Analytics:** GA4 (`G-MV6N6MXMFL`) + Meta Pixel (`2695492410615324`)
