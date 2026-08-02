Status: needs-triage

# Instrument the onboarding wizard for TTHW/drop-off measurement

## What

Track step entered/completed, time-to-launch, and whether "Preview a sample
post" gets used, so the champion-tier TTHW target (<5 min, connector
dead-end fixed) this review targeted is actually measurable once shipped.

## Why

Deferred out of `/plan-devex-review` on CreateAgentPage.tsx (Pass 8: DX
Measurement, 2/10 — zero instrumentation exists today). Without this, there's
no way to know if real users hit the target, where they actually drop off,
or whether the magic-moment fix (pre-filled preview) gets used at all. This
is exactly what a future `/devex-review` boomerang would need.

## Depends on / blocked by

Analytics provider + privacy-posture decision — not made in this review.

## Comments
