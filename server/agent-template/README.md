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
- Post statuses are the **raw backend vocabulary**: `draft` (awaiting review) |
  `scheduled` | `posting` | `posted` | `failed` | `cancelled`. Do not invent a
  simplified pending/approved/rejected set — the API returns these unmapped.
- Supported post platforms: linkedin, x/twitter, instagram, facebook, youtube,
  tiktok, threads, pinterest, telegram, whatsapp.
- **Never break what's already built.** Before adding or changing anything,
  check `src/App.tsx` and `src/pages/*` for what already exists — this is a
  live dashboard the user is actively using, not a blank scaffold. Extend
  existing pages/components in place rather than duplicating them; don't
  delete or rewrite a page you weren't asked to touch; a new feature is
  additive (a new route + nav entry) unless the user explicitly asks for a
  replacement.

## Common customizations

- **Rebrand**: change `--accent` and the sidebar/body tokens in `src/index.css`,
  or set `logoUrl` / `appName` in `src/ecg-config.ts`.
- **Hide a feature**: remove its key from `ECG.modules`.
- **New widget on Home**: extend `src/pages/DashboardPage.tsx`; fetch through
  `ecgApi`, never with raw `fetch`.
- **New custom page calling the API**: add a route + `ALL_NAV` entry, then
  call whatever `ecgApi` method fits (see reference below) — the API supports
  far more than the built-in pages use (bulk actions, visual-post generation,
  knowledge bases, notifications, etc.), so a custom feature request rarely
  needs a new backend endpoint.

## API reference (`ecgApi`, from `src/lib/ecgClient.ts`)

Every call goes through `ecgApi.<resource>.<method>()` — never raw `fetch`.
Each bridges to a real eCG Agent MCP tool call server-side. **MCP** = works for
every dashboard created via the current "Connect eCG Agent" flow (the normal
case). **Portal-only** = only works for a handful of older dashboards created
via the retired one-time launch-token flow; calling these from an MCP-key
dashboard fails with a clear "not available" error — don't build UI around them
unless asked to support that specific project.

| Resource | Calls | Support |
|---|---|---|
| `templates` | `list()` | MCP |
| `agents` | `list()` `get(id)` `create(data)` `update(id, data)` `delete(id)` `run(id)` | MCP |
| `schedulers` | `list()` `create(data)` `update(id, data)` `delete(id)` `trigger(id)` | MCP |
| `posts` | `list()` `create(data)` `delete(id)` `approve(id)` `reject(id)` `update(id, data)` `bulkApprove(ids)` `regenerate(id, feedback?)` | MCP |
| `visualPosts` | `list(plannedPostId?)` `get(id)` `generate(data)` `update(id, data)` `regenerate(id, data)` `finalize(id)` | MCP |
| `connectors` | `list()` `create(data)` `update(id, data)` `delete(id)` `test(id)` `discover(token)` | MCP |
| `runs` | `list()` | MCP |
| `notifications` | `list(unreadOnly?)` `markRead(id)` `markAllRead()` | MCP |
| `knowledge` | `list()` `upload(formData)` `delete(id)` | MCP |
| `knowledgeBases` | `list()` `create(data)` `update(id, data)` `delete(id)` | MCP |
| `orgSettings` | `get()` `update({ autoApprovePosts?, autoApproveConfidenceThreshold? })` | MCP (auto-approve trust dial only) |
| `org` | `get()` `update(data)` | Portal-only |
| `team` | `list()` `create(data)` `delete(id)` | Portal-only |
| `apiKeys` | `list()` `create(data)` `revoke(id)` | Portal-only |
| `billing` | `invoices()` | Portal-only |
| `summary` / `stats` | `get()` | `stats` is MCP; `summary` is portal-only |

`chat(messages)` (also in `ecgClient.ts`, used by `ChatPage.tsx`) is a
tool-calling assistant that can invoke any of the MCP tools above on the
user's behalf via natural language — extend `ChatPage.tsx`/server-side
`ecg-chat.routes.ts` rather than duplicating that logic in a new page.
