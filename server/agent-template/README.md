# {{APP_NAME}}

This project is an **eCG Agent dashboard** — a live control panel for a social-media
agent org, generated from a template and connected to real data. It is a normal
Vite + React + Tailwind project: every page is editable code.

## How it works (read this before editing)

- `src/ecg-config.ts` is the **customization surface**: app name, logo, layout
  (`sidebar` / `topnav` / `minimal`), enabled modules, and which agents are shown.
  Colors and fonts are CSS variables defined in `src/index.css` (`--accent`,
  `--sidebar-bg`, `--body-bg`, `--card-bg`, `--text`, `--muted`, `--border`, ...).
  **Restyle by changing tokens, not by hardcoding colors in components.**
- `src/lib/ecgClient.ts` is the **data layer**. It calls the eCG proxy API with a
  token read from the environment. All pages get live org data through it
  (agents, schedulers, posts, connectors, runs, knowledge).
- `src/components/Layout.tsx` renders the shell for all three layouts and builds
  the nav from `ECG.modules`. Add a page = add a route in `src/App.tsx` + an
  entry in `ALL_NAV`.
- `src/pages/*` are the module pages. They are self-contained and safe to
  restyle or extend.

## Guardrails

- Do **not** edit or remove `src/pages/AccessGate.tsx` or the token handling in
  `ecgClient.ts` — they are the dashboard's authentication.
- Do not hardcode API URLs or keys; the proxy URL and project id live in
  `src/ecg-config.ts` and secrets come from the environment.
- Post statuses from the API are `pending` / `approved` / `rejected` — the
  richer portal lifecycle is collapsed by the proxy, so do not invent extra
  states in the UI.
- Supported post platforms: linkedin, x/twitter, instagram, facebook, youtube,
  tiktok, threads, pinterest, telegram, whatsapp.

## Common customizations

- **Rebrand**: change `--accent` and the sidebar/body tokens in `src/index.css`,
  or set `logoUrl` / `appName` in `src/ecg-config.ts`.
- **Hide a feature**: remove its key from `ECG.modules`.
- **New widget on Home**: extend `src/pages/DashboardPage.tsx`; fetch through
  `ecgApi`, never with raw `fetch`.
