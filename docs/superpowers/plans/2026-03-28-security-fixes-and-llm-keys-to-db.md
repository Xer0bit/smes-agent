# Security Fixes & LLM Keys to DB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move LLM API keys from the filesystem into Supabase DB (admin-controlled), and fix all security issues identified in the code review (XSS, path traversal, unauthenticated exec, postMessage origin, TOCTOU race, dead code, context cap, pruneProjectFiles).

**Architecture:** The `llm-control.service.ts` persistence layer is swapped from `.llm-control.json` → a `system_settings` Supabase table (key=`llm_control`, value=JSON). The preview-service's unauthenticated `/exec` endpoint is removed (the authenticated equivalent in `system.routes.ts` already exists). Four security patches are applied to `preview-service/server.js`. Three minor fixes go to the frontend and backend service files.

**Tech Stack:** TypeScript, Express, Supabase JS v2, PostgreSQL, React, Node.js/ESM

---

## File Map

| File | Change |
|------|--------|
| `supabase/migrations/20260328100000_system_settings.sql` | CREATE — `system_settings` table + `increment_message_count` RPC |
| `server/src/services/llm-control.service.ts` | MODIFY — swap `loadPersisted`/`savePersisted` from JSON file to Supabase |
| `preview-service/server.js` | MODIFY — remove `/exec` endpoint, fix XSS (4 lines), fix path traversal, fix pruneProjectFiles |
| `src/pages/Editor.tsx` | MODIFY — add origin check to `postMessage` handler |
| `src/eCG/UserPrompt/messageService.ts` | MODIFY — remove `currentCount` param, use atomic RPC |
| `src/eCG/UserPrompt/promptService.ts` | MODIFY — remove read-before-increment, call atomic RPC directly |
| `src/eCG/eCGCloud/llmService.ts` | MODIFY — fix misleading comment/error string |
| `server/src/services/agentLoopService.ts` | MODIFY — sort files by modification time before slicing context |
| `.gitignore` | MODIFY — add `server/.llm-control.json` |

---

### Task 1: Supabase migration — `system_settings` table + atomic message count RPC

**Files:**
- Create: `supabase/migrations/20260328100000_system_settings.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- supabase/migrations/20260328100000_system_settings.sql
-- =============================================================================
-- System Settings
-- Generic key-value store for server-side admin configuration.
-- Used by llm-control.service.ts to persist LLM provider/model/key settings.
-- All access is via the authenticated backend API only (service_role key).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.system_settings (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL DEFAULT '{}',
    updated_at  timestamptz NOT NULL DEFAULT NOW()
);

-- No RLS policies = no direct authenticated-user access.
-- Service role bypasses RLS entirely.
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.system_settings TO service_role;

COMMENT ON TABLE public.system_settings IS
    'Server-side admin key-value store. Accessed only via service_role through backend API.';

-- =============================================================================
-- Atomic message count increment
-- Replaces the TOCTOU read-then-write pattern in promptService.ts
-- =============================================================================

CREATE OR REPLACE FUNCTION public.increment_message_count(p_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.projects
    SET message_count = COALESCE(message_count, 0) + 1
    WHERE id = p_project_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_message_count(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_message_count(uuid) TO service_role;
```

- [ ] **Step 2: Apply the migration to local Supabase**

Run:
```bash
cd /home/xer0bit/Desktop/ecomgear-main
supabase db reset --local
# OR if reset is too destructive:
supabase migration up --local
```
Expected: Migration applied with no errors. Table `system_settings` visible in Supabase Studio.

- [ ] **Step 3: Commit**

```bash
cd /home/xer0bit/Desktop/ecomgear-main
git add supabase/migrations/20260328100000_system_settings.sql
git commit -m "feat: add system_settings table and atomic increment_message_count RPC"
```

---

### Task 2: Switch LLM control persistence from JSON file to Supabase DB

**Files:**
- Modify: `server/src/services/llm-control.service.ts`

- [ ] **Step 1: Replace `loadPersisted` and `savePersisted` to use Supabase**

The entire file needs two functions replaced. All other logic (merging defaults, `applyRuntimeEnv`, exported functions) stays identical.

In `server/src/services/llm-control.service.ts`:

**Add this import** at the top (after existing imports):
```typescript
import { supabase } from '../config/database.js';
```

**Replace `loadPersisted`** (currently lines 144–152) with:
```typescript
async function loadPersisted(): Promise<PersistedLlmControl | null> {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'llm_control')
      .maybeSingle();

    if (error) {
      console.warn('[LlmControl] Failed to load from DB, using defaults:', error.message);
      return null;
    }
    return (data?.value ?? null) as PersistedLlmControl | null;
  } catch (err) {
    console.warn('[LlmControl] DB unavailable, using defaults:', err);
    return null;
  }
}
```

**Replace `savePersisted`** (currently lines 154–159) with:
```typescript
async function savePersisted(state: LlmControlState): Promise<void> {
  const { error } = await supabase
    .from('system_settings')
    .upsert(
      { key: 'llm_control', value: state as unknown as Record<string, unknown>, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );

  if (error) {
    throw new Error(`[LlmControl] Failed to save to DB: ${error.message}`);
  }
}
```

**Remove** the now-unused `fs` and `path` imports from the top of the file:
```typescript
// Remove these two lines:
import { promises as fs } from 'fs';
import path from 'path';
```

**Remove** the now-unused `getControlFilePath` function (lines 43–48).

- [ ] **Step 2: Verify the server still starts**

```bash
cd /home/xer0bit/Desktop/ecomgear-main/server
npm run build 2>&1 | tail -20
```
Expected: Build completes with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/llm-control.service.ts
git commit -m "feat: persist LLM control settings in Supabase DB instead of JSON file"
```

---

### Task 3: Remove committed secrets and add .llm-control.json to .gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Stop tracking `server/.env` (it's already in .gitignore, just untrack it)**

```bash
cd /home/xer0bit/Desktop/ecomgear-main
git rm --cached server/.env
```
Expected: Output: `rm 'server/.env'`

- [ ] **Step 2: Add `.llm-control.json` to `.gitignore`**

Open `.gitignore` and add after the `server/.env` line:
```
server/.llm-control.json
```

- [ ] **Step 3: Stop tracking `server/.llm-control.json` if it's tracked**

```bash
git rm --cached server/.llm-control.json 2>/dev/null || true
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: untrack server/.env and server/.llm-control.json — secrets must not be in git"
```

> **IMPORTANT after merging:** Rotate all 4 keys (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY, SUPABASE_SERVICE_KEY) in their respective dashboards. The old values are in git history and must be treated as compromised. On the production server, re-enter the new keys via the Admin → Settings page (which now saves to DB).

---

### Task 4: Fix preview-service/server.js — XSS, path traversal, exec endpoint, pruneProjectFiles

**Files:**
- Modify: `preview-service/server.js`

All four fixes are in the same file — do them in one edit pass.

- [ ] **Step 1: Remove the unauthenticated `/preview/:projectId/exec` endpoint**

Find and delete lines 1471–1496 (the block starting with `// Command Execution API: POST /preview/:projectId/exec` through the closing `});`).

The authenticated equivalent already exists in `server/src/routes/system.routes.ts` at `/system/exec`. The preview-service endpoint has no authentication middleware and must be removed.

After deletion the file should jump from the `/update` endpoint directly to:
```js
    // Preview Status API: GET /preview/:projectId/status
```

- [ ] **Step 2: Fix XSS — escape slug in all four 404 HTML responses**

Location 1 — `/p/:slug` route (around line 1247):
```js
// BEFORE:
return res.status(404).type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>404 – ${slug} not found</title>
...
<p><strong>${slug}</strong> is not published yet.</p>

// AFTER:
const safeSlug = escapeHtml(slug);
return res.status(404).type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>404 – ${safeSlug} not found</title>
...
<p><strong>${safeSlug}</strong> is not published yet.</p>
```

Location 2 — subdomain routing (around line 1280):
```js
// BEFORE:
return res.status(404).type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>404 – ${slug}.ecomgear.app</title>
...
<p><strong>${slug}.ecomgear.app</strong> is not published yet.</p>

// AFTER:
const safeSlug = escapeHtml(slug);
return res.status(404).type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>404 – ${safeSlug}.ecomgear.app</title>
...
<p><strong>${safeSlug}.ecomgear.app</strong> is not published yet.</p>
```

- [ ] **Step 3: Fix path traversal — validate projectId is a UUID before all filesystem ops**

Add a helper function near the top of server.js (after `escapeHtml`):
```js
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidProjectId(id) {
    return typeof id === 'string' && UUID_REGEX.test(id);
}
```

Then at the top of every route handler that uses `req.params.projectId` for filesystem ops, add:
```js
const { projectId } = req.params;
if (!isValidProjectId(projectId)) {
    return res.status(400).json({ error: 'Invalid project ID' });
}
```

The routes that need this guard are:
- `GET /preview/:projectId/status`
- `POST /preview/:projectId/update` (or equivalent update route)
- `GET /preview/:projectId/` (Vite serving route)
- `initProject(projectId)` call sites — add the check before calling `initProject`

- [ ] **Step 4: Fix `pruneProjectFiles` — protect `.vite-cache` and `.git`**

Find `pruneProjectFiles` (around line 364). Change:
```js
// BEFORE:
const protectedTopLevel = new Set(['node_modules']);

// AFTER:
const protectedTopLevel = new Set(['node_modules', '.vite-cache', '.git', '.cache']);
```

- [ ] **Step 5: Verify the preview service starts**

```bash
cd /home/xer0bit/Desktop/ecomgear-main/preview-service
node --check server.js
```
Expected: No syntax errors printed.

- [ ] **Step 6: Commit**

```bash
cd /home/xer0bit/Desktop/ecomgear-main
git add preview-service/server.js
git commit -m "fix: remove unauthenticated exec endpoint, fix XSS slug escaping, path traversal validation, and pruneProjectFiles protection"
```

---

### Task 5: Fix postMessage origin check in Editor.tsx

**Files:**
- Modify: `src/pages/Editor.tsx`

- [ ] **Step 1: Add origin validation to the message handler**

Find the `handleMessage` function (around line 370). Add an origin guard at the top of the handler:

```tsx
// BEFORE:
const handleMessage = (event: MessageEvent) => {
  if (event.data?.type === 'PREVIEW_LOG' && event.data.log) {

// AFTER:
const handleMessage = (event: MessageEvent) => {
  // Only accept messages from the preview service origin
  const allowedOrigins = [
    window.location.origin,
    import.meta.env.VITE_PREVIEW_SERVICE_URL,
  ].filter(Boolean);
  if (allowedOrigins.length > 0 && !allowedOrigins.some(o => event.origin === o || event.origin.startsWith(o as string))) {
    return;
  }
  if (event.data?.type === 'PREVIEW_LOG' && event.data.log) {
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/xer0bit/Desktop/ecomgear-main
npx tsc --noEmit 2>&1 | grep -i error | head -10
```
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Editor.tsx
git commit -m "fix: validate postMessage origin in Editor to prevent cross-origin spoofing"
```

---

### Task 6: Fix TOCTOU race — atomic message count increment

**Files:**
- Modify: `src/eCG/UserPrompt/messageService.ts`
- Modify: `src/eCG/UserPrompt/promptService.ts`

- [ ] **Step 1: Replace `incrementProjectMessageCount` with an atomic RPC call**

In `src/eCG/UserPrompt/messageService.ts`, replace the entire `incrementProjectMessageCount` method:

```typescript
// BEFORE:
async incrementProjectMessageCount(projectId: string, currentCount: number): Promise<void> {
  const { error } = await supabase
    .from("projects")
    .update({ message_count: currentCount + 1 })
    .eq("id", projectId);

  if (error) {
    console.error('[MessageService] Error incrementing message count:', error);
    throw error;
  }
},

// AFTER:
async incrementProjectMessageCount(projectId: string): Promise<void> {
  const { error } = await supabase.rpc('increment_message_count', {
    p_project_id: projectId,
  });

  if (error) {
    console.error('[MessageService] Error incrementing message count:', error);
    throw error;
  }
},
```

- [ ] **Step 2: Update the call site in promptService.ts**

In `src/eCG/UserPrompt/promptService.ts`, remove the read-before-increment block (lines 109–120) and replace with a single call:

```typescript
// BEFORE:
// Save user message to database
await messageService.saveUserMessage(projectId, promptText);

// Increment project message count
const { data: project } = await supabase
  .from('projects')
  .select('message_count')
  .eq('id', projectId)
  .single();

if (project) {
  await messageService.incrementProjectMessageCount(
    projectId,
    project.message_count || 0
  );
}

// AFTER:
// Save user message to database
await messageService.saveUserMessage(projectId, promptText);

// Atomically increment project message count (no read-before-write race)
await messageService.incrementProjectMessageCount(projectId);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep -i error | head -10
```
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/eCG/UserPrompt/messageService.ts src/eCG/UserPrompt/promptService.ts
git commit -m "fix: replace TOCTOU message_count read-then-write with atomic DB RPC"
```

---

### Task 7: Fix dead code in llmService.ts

**Files:**
- Modify: `src/eCG/eCGCloud/llmService.ts`

- [ ] **Step 1: Fix the misleading comment and error string**

In `src/eCG/eCGCloud/llmService.ts`:

```typescript
// BEFORE (line ~35):
/**
 * Call OpenAI API to generate files
 * This should be called from an edge function with OPENAI_API_KEY
 */
async generateFiles(
  request: LLMGenerationRequest,
  apiKey: string
): Promise<LLMGenerationResponse> {
  ...
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

// AFTER:
/**
 * Call Anthropic API to generate files (legacy — superseded by agentStreamService).
 * Used only by edge functions that pass an API key directly.
 */
async generateFiles(
  request: LLMGenerationRequest,
  apiKey: string
): Promise<LLMGenerationResponse> {
  ...
  if (!apiKey) {
    throw new Error("Anthropic API key is not configured");
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/eCG/eCGCloud/llmService.ts
git commit -m "fix: correct misleading OpenAI comment and error message in llmService (uses Anthropic)"
```

---

### Task 8: Fix context window capping — sort by most recently modified

**Files:**
- Modify: `server/src/services/agentLoopService.ts`

- [ ] **Step 1: Sort existing files by path relevance before slicing**

In `agentLoopService.ts`, find the context-building block (around line 173):

```typescript
// BEFORE:
const existingFilesContext = (existingFiles ?? [])
  .slice(0, 20)                                   // Cap to avoid huge context
  .map((f) => `=== ${f.path} ===\n${f.content}`)
  .join('\n\n');

// AFTER:
// Prioritise small files and files whose names appear in the prompt (rough relevance sort)
const promptLower = prompt.toLowerCase();
const sortedFiles = (existingFiles ?? []).slice().sort((a, b) => {
  const aRelevant = promptLower.includes(a.path.toLowerCase().split('/').pop() ?? '') ? -1 : 0;
  const bRelevant = promptLower.includes(b.path.toLowerCase().split('/').pop() ?? '') ? -1 : 0;
  if (aRelevant !== bRelevant) return aRelevant - bRelevant;
  // Secondary: smaller files first (avoid blowing context with large ones)
  return a.content.length - b.content.length;
});

// Cap by total character count (~80k chars ≈ safe context headroom for Haiku/Flash)
const MAX_CONTEXT_CHARS = 80_000;
let totalChars = 0;
const cappedFiles = sortedFiles.filter((f) => {
  totalChars += f.content.length + f.path.length + 10;
  return totalChars <= MAX_CONTEXT_CHARS;
});

const existingFilesContext = cappedFiles
  .map((f) => `=== ${f.path} ===\n${f.content}`)
  .join('\n\n');
```

- [ ] **Step 2: Verify build**

```bash
cd /home/xer0bit/Desktop/ecomgear-main/server
npm run build 2>&1 | tail -10
```
Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/agentLoopService.ts
git commit -m "fix: sort existing files by prompt relevance and cap by char count instead of fixed 20-file limit"
```

---

## Self-Review

**Spec coverage check:**
- ✅ LLM API keys → DB: Task 1 (migration) + Task 2 (service change)
- ✅ Admin panel still works: no UI change needed — `system.routes.ts` → `llm-control.service.ts` → DB
- ✅ Remove committed secrets: Task 3
- ✅ Unauthenticated `/exec` removed: Task 4 Step 1
- ✅ XSS slug escaping: Task 4 Step 2
- ✅ Path traversal validation: Task 4 Step 3
- ✅ `pruneProjectFiles` protection: Task 4 Step 4
- ✅ `postMessage` origin check: Task 5
- ✅ TOCTOU message count race: Task 6
- ✅ Dead code in `llmService.ts`: Task 7
- ✅ Context window capping: Task 8

**Out of scope (minor, not blocking):**
- SRI hashes on CDN scripts in `previewGenerator.ts` — deferred, no security boundary since content is already trusted
- `twMerge` stub visual regression — deferred, cosmetic only
- `Editor.tsx` state extraction into hooks — refactor, not a bug
