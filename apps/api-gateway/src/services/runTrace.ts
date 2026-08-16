/**
 * RunTracer — full-activity trace of one agent run, one JSONL file per run.
 *
 * Purpose: replayable evidence. Every run records its system prompt, every
 * step's text/tool calls/tool results/usage, service calls (preview pushes),
 * and the final outcome, so a stuck or expensive run can be reconstructed
 * offline in a test environment instead of diagnosed from pm2 log fragments
 * (the 2026-08-16 stuck-loop took ssh archaeology across three servers; a
 * trace file answers the same question with `cat`).
 *
 * Design constraints:
 * - Tracing must NEVER break or slow a run: every fs call is try/caught,
 *   appendFileSync on a local disk is microseconds at this volume.
 * - Disk-bounded: day-directories, pruned after KEEP_DAYS on run start.
 * - Values are clipped (CLIP chars) except the system prompt, which is the
 *   single most-needed artifact for replay and is stored whole.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'fs';
import path from 'path';

const TRACE_ROOT = process.env.AGENT_TRACE_DIR || '/var/www/ecomgear/traces';
const KEEP_DAYS = 14;
const CLIP = 4000;

function clip(v: unknown): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  return s.length > CLIP ? `${s.slice(0, CLIP)}…[+${s.length - CLIP} chars]` : s;
}

export class RunTracer {
  private file: string | null = null;

  constructor(runId: string, projectId: string) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dir = path.join(TRACE_ROOT, today);
      mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, `${runId}.jsonl`);

      const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
      for (const entry of readdirSync(TRACE_ROOT)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(entry) && entry < cutoff) {
          rmSync(path.join(TRACE_ROOT, entry), { recursive: true, force: true });
        }
      }
      this.event('run-start', { runId, projectId });
    } catch {
      this.file = null;
    }
  }

  /** Append one trace event. Values are pre-clipped by the caller via RunTracer.clip. */
  event(type: string, data: Record<string, unknown>): void {
    if (!this.file) return;
    try {
      appendFileSync(this.file, `${JSON.stringify({ t: new Date().toISOString(), type, ...data })}\n`);
    } catch {
      // Tracing must never break the run.
    }
  }

  static clip = clip;
}
