-- =============================================================================
-- Agent Skill Templates (Admin-Managed Global Library)
-- Platform admins manage these; users can one-click apply them to any project.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.agent_skill_templates (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text          NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description   text          NOT NULL CHECK (char_length(description) BETWEEN 1 AND 2000),
  category      text          NOT NULL DEFAULT 'general'
                              CHECK (category IN ('coding','design','architecture','data','general')),
  is_default    boolean       NOT NULL DEFAULT false,   -- auto-seeded to new projects
  sort_order    integer       NOT NULL DEFAULT 0,
  created_by    uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_skill_templates_default
  ON public.agent_skill_templates(is_default);

CREATE INDEX IF NOT EXISTS idx_agent_skill_templates_sort
  ON public.agent_skill_templates(sort_order, created_at);

-- Updated_at trigger (reuse function from project_agent_skills migration)
DROP TRIGGER IF EXISTS trg_agent_skill_templates_updated_at ON public.agent_skill_templates;
CREATE TRIGGER trg_agent_skill_templates_updated_at
  BEFORE UPDATE ON public.agent_skill_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: all authenticated users can read templates; only admins can write
ALTER TABLE public.agent_skill_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "templates_select_authenticated"
  ON public.agent_skill_templates FOR SELECT
  USING (auth.role() = 'authenticated');

-- Admin write guard: checks org_members with role = 'admin' OR the user is in the
-- admin allow-list (fallback: the seeded a0000000 admin UUID always passes).
CREATE POLICY "templates_admin_insert"
  ON public.agent_skill_templates FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.org_members
      WHERE user_id = auth.uid() AND role IN ('admin')
    )
    OR auth.uid() = 'a0000000-0000-0000-0000-000000000001'::uuid
  );

CREATE POLICY "templates_admin_update"
  ON public.agent_skill_templates FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members
      WHERE user_id = auth.uid() AND role IN ('admin')
    )
    OR auth.uid() = 'a0000000-0000-0000-0000-000000000001'::uuid
  );

CREATE POLICY "templates_admin_delete"
  ON public.agent_skill_templates FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members
      WHERE user_id = auth.uid() AND role IN ('admin')
    )
    OR auth.uid() = 'a0000000-0000-0000-0000-000000000001'::uuid
  );

-- =============================================================================
-- Seed: Best-practice default skill templates
-- is_default = true → automatically applied to every new project
-- =============================================================================

INSERT INTO public.agent_skill_templates
  (name, description, category, is_default, sort_order)
VALUES

-- ── Coding ──────────────────────────────────────────────────────────────────
(
  'TypeScript Strict Mode',
  E'Always use TypeScript with strict type safety:\n'
  '- Never use `any`. Use `unknown` and narrow with type guards, or use a specific union type.\n'
  '- Every function must have explicit parameter types and a return type annotation.\n'
  '- Prefer `interface` for object shapes and `type` for unions/intersections.\n'
  '- Use `const` by default; only `let` when a value will be reassigned.\n'
  '- No implicit `undefined` — mark optional props explicitly with `?`.',
  'coding', true, 0
),
(
  'React Best Practices',
  E'Follow modern React patterns in every component:\n'
  '- Functional components only — no class components.\n'
  '- Use `useState`, `useEffect`, `useCallback`, `useMemo` correctly; do not over-memoize.\n'
  '- Split large components — each component should do one thing and be under ~150 lines.\n'
  '- Use proper dependency arrays in hooks; never ignore exhaustive-deps lint warnings.\n'
  '- Avoid `useEffect` for data derivable from existing state — derive it inline or with `useMemo`.\n'
  '- Always give list items stable `key` props (not array index).',
  'coding', true, 1
),
(
  'Error Boundaries & Loading States',
  E'Every async operation and data-fetching component must handle all states:\n'
  '- Show a loading skeleton or spinner while data is fetching.\n'
  '- Show a descriptive error message (never a raw error stack) when a request fails.\n'
  '- Use try/catch in async functions and surface errors with toast or inline feedback.\n'
  '- Never leave UI in a partially-broken state (e.g., empty list with no message).',
  'coding', true, 2
),

-- ── Design ──────────────────────────────────────────────────────────────────
(
  'Tailwind CSS — No Custom Classes',
  E'Use Tailwind CSS utility classes exclusively for all styling:\n'
  '- Standard palette only: slate, gray, zinc, neutral, stone, red, orange, amber, yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple, fuchsia, pink, rose.\n'
  '- Do NOT use arbitrary values like `bg-[#abc]` unless absolutely unavoidable — use the nearest Tailwind scale step instead.\n'
  '- Do NOT create new CSS classes in `.css` files; use Tailwind utilities or @apply.\n'
  '- Do NOT use inline `style={{}}` props except for dynamic values that cannot be expressed as utilities.',
  'design', true, 3
),
(
  'Responsive Design — Mobile First',
  E'Every layout must be fully responsive:\n'
  '- Start with the mobile layout (no prefix) then add `sm:`, `md:`, `lg:` breakpoints progressively.\n'
  '- Use `flex` or `grid` for layout — never fixed pixel widths on containers.\n'
  '- Text must remain readable on a 375px viewport. Use `text-sm` minimum.\n'
  '- Touch targets (buttons, links) must be at least 44×44px (`min-h-11 min-w-11`).\n'
  '- Images must use `object-cover` or `object-contain` with explicit `aspect-ratio` constraints.',
  'design', true, 4
),
(
  'Accessibility (a11y)',
  E'Generate accessible HTML and React JSX:\n'
  '- Every interactive element (`<button>`, `<input>`, `<select>`) must have a visible or `sr-only` label.\n'
  '- Images require descriptive `alt` text. Decorative images use `alt=""`.\n'
  '- Use semantic HTML elements: `<nav>`, `<main>`, `<section>`, `<article>`, `<aside>`, `<header>`, `<footer>`.\n'
  '- Focus indicators must remain visible — never `outline-none` without a custom focus style.\n'
  '- Color is never the sole means of conveying information.',
  'design', true, 5
),

-- ── Architecture ─────────────────────────────────────────────────────────────
(
  'File & Folder Structure',
  E'Maintain a clean, predictable project structure:\n'
  '- `src/components/` — reusable UI atoms and molecules.\n'
  '- `src/pages/` — one file per route; thin, mostly composition.\n'
  '- `src/hooks/` — custom React hooks; prefix every hook with `use`.\n'
  '- `src/services/` — API calls and business logic; no JSX.\n'
  '- `src/types/` — shared TypeScript interfaces and type aliases.\n'
  '- `src/lib/` or `src/utils/` — pure utility functions with no side-effects.\n'
  '- Keep component files under 200 lines; extract sub-components when they grow.',
  'architecture', true, 6
),
(
  'Separation of Concerns',
  E'Strictly separate UI, data, and business logic:\n'
  '- Components contain ONLY rendering logic and local UI state.\n'
  '- Data fetching goes in custom hooks (`useData`) or a service layer — never directly in a component body.\n'
  '- Business logic (validation, transformations) belongs in pure utility functions.\n'
  '- Database or API calls must never appear inside a React component render function.',
  'architecture', false, 7
),

-- ── Data ────────────────────────────────────────────────────────────────────
(
  'Supabase Data Patterns',
  E'When querying or mutating Supabase data:\n'
  '- Always check for `error` after every Supabase call and handle it explicitly.\n'
  '- Use `maybeSingle()` not `single()` when a row may not exist.\n'
  '- Use RLS-aware queries; never expose service role keys on the client.\n'
  '- Prefer typed responses: annotate `.select()` return values with the correct TypeScript type.\n'
  '- Use `upsert` for idempotent operations instead of checking-then-inserting.',
  'data', false, 8
),

-- ── General ──────────────────────────────────────────────────────────────────
(
  'Code Quality & Comments',
  E'Write self-documenting, maintainable code:\n'
  '- Add a one-line JSDoc comment to every exported function describing what it does.\n'
  '- Name variables and functions descriptively — no single-letter names except loop counters.\n'
  '- Keep functions short (under 40 lines); extract helpers for anything longer.\n'
  '- Remove all `console.log` debug statements before finalizing; use `console.warn`/`console.error` for legitimate runtime messages only.\n'
  '- Do NOT leave TODO/FIXME comments in generated code.',
  'general', false, 9
);
