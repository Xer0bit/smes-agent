// Dead-but-dangerous edge function scan -- runs once per agent turn (see
// runAgentLoop in agentLoopService.ts) to catch the failure class that
// shipped live in a real project (CardPro, 2026-08-08): a sensitive-category
// edge function (auth/password/session) that the frontend never calls, but
// is still deployed and invokable by anyone holding the project's public
// anon key. find_symbol_usages/symbolGraph can't see this -- edge functions
// are invoked by string name, not as a JS symbol -- so this is a separate,
// deliberately narrow grep-based check, not a general dead-code scanner.
//
// Findings are NOT auto-deleted and NOT silently logged. They're appended to
// projects.context_notes, the same durable cross-session memory mechanism
// ecg-dev-agent.routes.ts already uses -- surfaced to the human via the UI
// and to the agent on its next turn, until someone makes an explicit
// delete-vs-keep decision. Idempotent: a function already flagged isn't
// re-appended on every turn.
import fs from 'node:fs';
import path from 'node:path';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { recordKnowledge, type KnowledgeEntry } from './knowledge.service.js';

// Excludes webhooks deliberately: webhook handlers (e.g. stripe-webhook) are
// legitimately called only by an external third party, never from src/, by
// design -- write_edge_function.ts's own description lists "webhook
// handlers" as a normal use case. Flagging every unreferenced webhook would
// make this check noisy enough to get ignored, which defeats the point.
const SENSITIVE_NAME_RE = /(auth|password|login|signup|credential|session|token)/i;
const WEBHOOK_RE = /webhook/i;

function isReferencedInSource(appPath: string, functionName: string): boolean {
  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return true; // can't confirm absence -- don't flag on missing data

  const needle = `'${functionName}'`;
  const needleDq = `"${functionName}"`;
  const stack = [srcDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      let content: string;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (content.includes(needle) || content.includes(needleDq)) return true;
    }
  }
  return false;
}


export async function scanForDeadDangerousEdgeFunctions(projectId: string, appPath: string): Promise<void> {
  try {
    const { data: fns, error } = await supabase
      .from('edge_functions')
      .select('name')
      .eq('project_id', projectId);
    if (error || !fns || fns.length === 0) return;

    const candidates = fns
      .map((f: { name: string }) => f.name)
      .filter((name: string) => SENSITIVE_NAME_RE.test(name) && !WEBHOOK_RE.test(name));
    if (candidates.length === 0) return;

    // One knowledge note per function, keyed by name: re-scanning updates the
    // row instead of appending another copy, and the owner can archive or
    // delete a finding they have decided about (Settings → Knowledge).
    const findings: KnowledgeEntry[] = [];
    for (const name of candidates) {
      if (isReferencedInSource(appPath, name)) continue; // actually used, nothing to flag
      findings.push({
        source: 'note',
        source_ref: `security:${name}`,
        heading: `Security finding: edge function "${name}"`,
        content:
          `Edge function "${name}" touches auth/password/session logic but is not referenced anywhere in ` +
          `the current frontend source (checked src/**/*.{ts,tsx,js,jsx} for '${name}' as a string literal). ` +
          `It is still deployed and invokable by anyone with this project's anon key. Needs an explicit decision: ` +
          `delete it with delete_edge_function if abandoned, or wire it up (and confirm it hashes passwords, not ` +
          `compares them raw) if it's still needed. (auto-detected ${new Date().toISOString().slice(0, 10)})`,
      });
    }
    if (findings.length === 0) return;
    await recordKnowledge(projectId, findings);
  } catch (err) {
    logger.warn('[edgeFunctionSecurityScan] scan failed (non-fatal)', err);
  }
}
