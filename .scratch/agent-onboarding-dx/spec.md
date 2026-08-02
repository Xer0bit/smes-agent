# Agent onboarding wizard: DX polish pass

Status: ready-for-agent

## Why

/plan-devex-review on CreateAgentPage.tsx's 4-step wizard (Select Template →
Connect → Personalize → Review & Launch), reviewed against a solo-founder
persona (no marketing team, ~5 min tolerance). Full persona/benchmark/journey
work lives in the review artifact; this spec is just the resulting build list.

The one structural gap: Step 2's "no connector" empty state sends the user to
a totally different page (`/connectors`), destroying all wizard state
(template pick, everything). No competitor in this space (Buffer, Hootsuite)
makes account-connection a mid-wizard dead end.

## Scope

- Fix the connector dead-end: either an inline connect flow at Step 2, or
  persist+restore wizard state across the round-trip (design decision, not
  yet made — needs its own pass before implementation)
- Wizard state persists to localStorage, restores on remount ("Resumed your
  draft from earlier")
- Step 3 pre-fills Instructions with the template's hint text as a real
  starting draft; Preview button active immediately, not gated behind 40
  characters
- Post-launch success screen shows "First scheduled post: [day] at [time]"
  + a [View Run History] link alongside [Go to Agents]
- Generic launch/save failures get a consistent problem+fix line appended,
  not just the raw backend message (CreateAgentPage.tsx AND EditAgentPage.tsx)
- EditAgentPage warns before saving if an unchecked connector has an active
  scheduler depending on it
- Persistent Help/Support link added to the sidebar nav
- Wizard buttons (Continue/Back/Launch/day toggles) get 44px min-height,
  matching the standard already set on RunsPage

## Comments
