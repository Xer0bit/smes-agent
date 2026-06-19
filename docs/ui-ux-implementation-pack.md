# eCOMGear UI/UX Implementation Pack

## 1) Route and Component Map (aligned to current codebase)

### 1.1 Current route inventory and target IA mapping

| Current Route | Current Entry | Keep/Change | Target Experience Zone | Primary Layout Owner |
|---|---|---|---|---|
| / | src/pages/Index.tsx | Keep | Public marketing | src/layouts/LandingLayout.tsx |
| /features | src/pages/landing/Features.tsx | Keep | Public marketing | src/layouts/LandingLayout.tsx |
| /pricing | src/pages/landing/Pricing.tsx | Keep | Public marketing | src/layouts/LandingLayout.tsx |
| /about | src/pages/landing/About.tsx | Keep | Public marketing | src/layouts/LandingLayout.tsx |
| /contact | src/pages/landing/Contact.tsx | Keep | Public marketing | src/layouts/LandingLayout.tsx |
| /privacy | src/pages/landing/PrivacyPolicy.tsx | Keep | Public marketing | src/layouts/LandingLayout.tsx |
| /terms | src/pages/landing/TermsOfService.tsx | Keep | Public marketing | src/layouts/LandingLayout.tsx |
| /security | src/pages/landing/Security.tsx | Keep | Public marketing | src/layouts/LandingLayout.tsx |
| /blog | src/pages/landing/Blog.tsx | Keep | Public marketing | src/layouts/LandingLayout.tsx |
| /agents | src/pages/landing/Agents.tsx | Keep | Public marketing | src/layouts/LandingLayout.tsx |
| /auth | src/pages/Auth.tsx | Change flow | Auth + onboarding step 1 | src/pages/Auth.tsx |
| /auth/callback | src/pages/AuthCallback.tsx | Keep | Auth infra | src/pages/AuthCallback.tsx |
| /dashboard | src/pages/dashboard/Home.tsx | Keep + redesign | Workspace Home | src/pages/Dashboard.tsx |
| /dashboard/organizations | src/pages/dashboard/Organizations.tsx | Keep | Collaborators/Org | src/pages/Dashboard.tsx |
| /dashboard/projects | src/pages/dashboard/Projects.tsx | Keep + redesign | Projects | src/pages/Dashboard.tsx |
| /dashboard/profile | src/pages/dashboard/Profile.tsx | Keep | Profile | src/pages/Dashboard.tsx |
| /dashboard/settings | src/pages/dashboard/Settings.tsx | Refactor | Settings hub | src/pages/Dashboard.tsx |
| /project/:projectId | src/pages/EditorWithWorkspace.tsx | Keep + major refactor | Builder OS | src/pages/Editor.tsx |
| /invite/:token | src/pages/AcceptInvite.tsx | Keep | Invite acceptance | src/pages/AcceptInvite.tsx |
| /project-invite/:token | src/pages/AcceptProjectInvite.tsx | Keep | Invite acceptance | src/pages/AcceptProjectInvite.tsx |
| /admin/login | src/pages/admin/Login.tsx | Keep | Admin auth | src/pages/admin/Login.tsx |
| /admin/* | src/pages/admin/AdminApp.tsx | Keep + visual align | Admin console | src/pages/admin/AdminApp.tsx |

Reference route registry: src/App.tsx

### 1.2 Builder OS route shape on top of existing paths

Keep URL stable for now, but split the editor into mode tabs using URL search params:

- /project/:projectId?tab=brief
- /project/:projectId?tab=generate
- /project/:projectId?tab=code
- /project/:projectId?tab=preview
- /project/:projectId?tab=revisions
- /project/:projectId?tab=publish

Why: no route migration risk, immediate deep-linking, lower refactor cost in src/pages/Editor.tsx.

### 1.3 Component responsibility map

| Concern | Existing Components To Reuse | Refactor Goal |
|---|---|---|
| App shell + auth gate | src/pages/Dashboard.tsx, src/pages/admin/AdminApp.tsx | Unify nav behavior and spacing rhythm |
| Builder left/center/right zones | src/pages/Editor.tsx, src/components/UnifiedAgentPanel.tsx, src/components/CodeEditorPanel.tsx, src/components/MultiDevicePreview.tsx, src/components/RevisionPanel.tsx, src/components/TerminalPanel.tsx | Convert from simultaneous panes to mode-based workspace |
| Collaboration | src/components/ProjectShareDialog.tsx, src/components/ProjectMemberAccess.tsx | Single collaborators panel UX |
| Settings | src/components/settings/SettingsDialog.tsx, src/pages/dashboard/Settings.tsx | Route-like sections inside dashboard settings page |
| Project listing | src/pages/dashboard/Projects.tsx | Standardized card/list actions and status badges |
| Invites | src/pages/AcceptInvite.tsx, src/pages/AcceptProjectInvite.tsx | Add explicit success state and next action |
| Quota feedback | src/components/QuotaLimitDialog.tsx, src/contexts/UsageContext.tsx | Persistent usage meter + progressive warnings |

## 2) Screen-by-Screen Wireframe Spec

## 2.1 Workspace Home (/dashboard)

Goal: start work in under 30 seconds.

Desktop blocks:
1. Header strip
- Left: workspace title + org switch context.
- Right: usage meter chip + Create Project button.
2. Next Steps panel (top priority)
- Checklist: create project, run first generation, invite teammate, publish.
3. Recent Projects row
- 3 to 6 cards with Open Builder and Preview actions.
4. Pending invitations panel
- Keep current invitation list behavior.

Mobile blocks:
1. Sticky top title + usage chip.
2. Full-width checklist cards.
3. Horizontal project scroller.
4. Bottom nav appears on all dashboard screens.

Primary components:
- Card, Badge, Button, Progress, Tabs.

## 2.2 Projects (/dashboard/projects)

Goal: quick scan and quick action.

Desktop blocks:
1. Toolbar row
- Search, status filter, view toggle, Create Project.
2. Data area
- Grid by default; list for dense workflows.
3. Project card
- Name, org, revision count, last update, status badges.
- CTA row: Open, Preview, Share, More.

Mobile blocks:
1. Search + filter chips.
2. Stacked compact project cards.
3. Floating Create Project button.

Primary components:
- Input, Select, Tabs, Table, DropdownMenu, Badge.

## 2.3 Builder OS (/project/:projectId)

Goal: one focus mode at a time, fast switching.

Desktop layout:
1. Top bar
- Project name, mode tabs, usage meter, Share, Publish.
2. Main stage
- Active tab content only.
3. Utility drawer (right, optional)
- AI activity, changed files, run logs.

Mobile layout:
1. Top segmented tabs.
2. Main full-screen mode content.
3. AI assistant opens as bottom sheet.
4. Preview has dedicated fullscreen toggle.

Mode wireframes:
1. Brief tab
- Prompt scaffolding fields.
- Suggested prompt chips.
- Generate button fixed at bottom.
2. Generate tab
- Step timeline: planning, scaffolding, styling, validation, done.
- Live log feed.
3. Code tab
- File tree collapsible.
- Monaco editor as primary surface.
- AI patch review panel docked.
4. Preview tab
- Device selector: desktop/tablet/mobile.
- URL/open-in-new-tab controls.
- Visual QA checklist.
5. Revisions tab
- Timeline list with diff and restore action.
6. Publish tab
- Domain/subdomain form.
- DNS checklist.
- Publish and post-publish verification state.

Primary components:
- Tabs, Sheet, Resizable, Card, Badge, Button, Progress, Tooltip.

## 2.4 Collaborators and Access (merge existing share flows)

Placement:
- Entry from builder top bar Share button and project row Share action.

Wireframe blocks:
1. Invite section
- Email invites, role select, link invite.
2. Members table
- Name, role, access scope, joined date, actions.
3. Permission matrix helper
- Viewer, Editor, Client capability chips.

Primary components:
- Dialog, Table, Select, Badge, Button.

## 2.5 Usage and Billing

Placement:
- Dashboard settings page and compact header usage chip.

Wireframe blocks:
1. Plan card with current tier and renewal/reset date.
2. Monthly usage meter with thresholds (70/90/100).
3. Upgrade cards with feature deltas.

Primary components:
- Card, Progress, Badge, Button.

## 3) Tailwind Token Set (drop-in)

Goal: semantic tokens so UI intent is stable even when palette evolves.

Edit src/index.css and add semantic aliases under :root:

```css
:root {
  /* Existing foundation remains untouched */

  /* Surface scale */
  --surface-0: var(--background);
  --surface-1: 210 28% 14%;
  --surface-2: 210 24% 18%;
  --surface-3: 210 22% 22%;

  /* Text scale */
  --text-strong: var(--foreground);
  --text-muted: var(--muted-foreground);
  --text-soft: 210 14% 72%;

  /* Action semantics */
  --action-primary: var(--primary);
  --action-primary-contrast: var(--primary-foreground);
  --action-secondary: var(--secondary);
  --action-secondary-contrast: var(--secondary-foreground);

  /* Feedback semantics */
  --feedback-success: 145 70% 42%;
  --feedback-warning: 32 95% 54%;
  --feedback-danger: var(--destructive);
  --feedback-info: 198 88% 56%;

  /* Focus and interaction */
  --focus-ring: var(--ring);
  --interactive-hover: 210 24% 24%;
  --interactive-active: 210 24% 28%;

  /* Elevation */
  --elev-1: 0 8px 24px hsl(220 45% 5% / 0.24);
  --elev-2: 0 18px 44px hsl(220 45% 5% / 0.30);
}
```

Extend src/tailwind.config.ts with semantic colors and elevations:

```ts
extend: {
  colors: {
    surface: {
      0: "hsl(var(--surface-0))",
      1: "hsl(var(--surface-1))",
      2: "hsl(var(--surface-2))",
      3: "hsl(var(--surface-3))",
    },
    text: {
      strong: "hsl(var(--text-strong))",
      muted: "hsl(var(--text-muted))",
      soft: "hsl(var(--text-soft))",
    },
    action: {
      primary: "hsl(var(--action-primary))",
      secondary: "hsl(var(--action-secondary))",
    },
    feedback: {
      success: "hsl(var(--feedback-success))",
      warning: "hsl(var(--feedback-warning))",
      danger: "hsl(var(--feedback-danger))",
      info: "hsl(var(--feedback-info))",
    },
  },
  boxShadow: {
    elev1: "var(--elev-1)",
    elev2: "var(--elev-2)",
  },
}
```

## 4) UI Primitives You Can Implement Immediately

All targets below already exist in your codebase.

## 4.1 Buttons

File target: src/components/ui/button.tsx

Add intent variants:
- primary: strong CTA.
- neutral: low emphasis action.
- success, warning: workflow states.

Use current cva system; add variants rather than ad-hoc class overrides across pages.

## 4.2 Cards

File target: src/components/ui/card.tsx

Add density and elevation options:
- density: comfy, compact.
- elevation: flat, elevated.

Result: consistent dashboard/project/admin cards.

## 4.3 Status pill

File target: src/components/ui/badge.tsx

Standardize status colors:
- active/success, warning, error, info, neutral.

Result: same status language across projects, billing, invites, preview health.

## 4.4 App section header

File target: src/components/ui/separator.tsx (plus new helper in existing dashboard pages)

Create a reusable section header pattern with:
- title
- supporting text
- optional right-side actions

Result: shared hierarchy in Home, Projects, Settings.

## 4.5 Builder mode tabs

File target: src/components/ui/tabs.tsx

Create a specialized style preset for builder mode tabs:
- large hit area
- active indicator
- sticky top behavior support

Result: reduces custom tab styling in src/pages/Editor.tsx.

## 4.6 Mobile assistant sheet

File target: src/components/ui/sheet.tsx

Adopt bottom-sheet pattern for AI panel at small breakpoints.

Result: replaces full-width overlay feel in editor mobile UX.

## 5) Implementation sequence (execution-ready)

Week 1:
1. Introduce semantic tokens in src/index.css and src/tailwind.config.ts.
2. Update button/card/badge primitive variants.
3. Normalize spacing and header rhythm in dashboard pages.

Week 2:
1. Add builder mode tab state in src/pages/Editor.tsx via URL query param tab.
2. Move agent panel to bottom sheet on small screens.
3. Add persistent usage chip in builder top bar.

Week 3:
1. Merge share and member access into one collaborators panel.
2. Add revisions timeline tab and explicit restore action pattern.
3. Refactor settings into sectioned in-page navigation.

Week 4:
1. Admin visual alignment pass (same spacing/token system as user app).
2. Accessibility pass (focus rings, keyboard order, aria labels).
3. Motion polish pass with reduced-motion fallback already in place.

## 6) Acceptance criteria

1. Builder mobile usability: all core actions reachable in 3 taps or fewer.
2. First-time flow: user can create and run first generation without leaving dashboard and builder path.
3. Visual consistency: no page-level hardcoded color classes for primary CTA intent.
4. Navigation consistency: authenticated routes share one interaction model.
5. Quota clarity: user can see usage status without triggering a blocking modal.

## 7) Files to use as implementation anchors

- src/App.tsx
- src/pages/Dashboard.tsx
- src/pages/dashboard/Home.tsx
- src/pages/dashboard/Projects.tsx
- src/pages/dashboard/Settings.tsx
- src/pages/Editor.tsx
- src/pages/EditorWithWorkspace.tsx
- src/pages/admin/AdminApp.tsx
- src/components/UnifiedAgentPanel.tsx
- src/components/CodeEditorPanel.tsx
- src/components/MultiDevicePreview.tsx
- src/components/RevisionPanel.tsx
- src/components/ProjectShareDialog.tsx
- src/components/ProjectMemberAccess.tsx
- src/components/ui/button.tsx
- src/components/ui/card.tsx
- src/components/ui/badge.tsx
- src/components/ui/tabs.tsx
- src/components/ui/sheet.tsx
- src/index.css
- tailwind.config.ts
