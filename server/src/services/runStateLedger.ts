/**
 * RunStateLedger — per-run change journal for the agent loop.
 *
 * Records every file read, write, and edit during a single agent run.
 * Emits a compact journal block injected into each step's context via
 * prepareStep so the agent always knows what it has done this run —
 * even after context compaction truncates the tool call history.
 */

export type LedgerOperationType = 'read' | 'write' | 'edit' | 'edit-failed';

interface LedgerEntry {
  step: number;
  operation: LedgerOperationType;
  path: string;
  detail: string;
}

export class RunStateLedger {
  private entries: LedgerEntry[] = [];
  private currentStep = 0;

  setStep(n: number): void {
    this.currentStep = n;
  }

  recordRead(path: string, lineCount: number): void {
    this.entries.push({
      step: this.currentStep,
      operation: 'read',
      path,
      detail: `${lineCount} lines`,
    });
  }

  recordWrite(path: string, lineCount: number, topExports: string): void {
    const detail = topExports
      ? `${lineCount} lines — exports: ${topExports}`
      : `${lineCount} lines`;
    this.entries.push({ step: this.currentStep, operation: 'write', path, detail });
  }

  recordEdit(path: string, searchSnippet: string): void {
    const snippet = searchSnippet.slice(0, 60).replace(/\n/g, '↵');
    this.entries.push({
      step: this.currentStep,
      operation: 'edit',
      path,
      detail: `target: "${snippet}"`,
    });
  }

  recordEditFailed(path: string, searchSnippet: string, reason: string): void {
    const snippet = searchSnippet.slice(0, 60).replace(/\n/g, '↵');
    this.entries.push({
      step: this.currentStep,
      operation: 'edit-failed',
      path,
      detail: `SEARCH not matched: "${snippet}" — ${reason.slice(0, 120)}`,
    });
  }

  buildJournalBlock(): string {
    if (this.entries.length === 0) return '';
    const icon = (op: LedgerOperationType) => op === 'edit-failed' ? '❌' : '✅';
    const lines = this.entries.map(e => {
      const base = `${icon(e.operation)} ${e.operation.padEnd(11)} ${e.path}`;
      if (e.operation === 'edit-failed') {
        return (
          `${base}\n` +
          `              → ${e.detail}\n` +
          `              → You MUST call read_file("${e.path}") and retry with exact content.`
        );
      }
      return e.detail ? `${base} — ${e.detail}` : base;
    });
    return (
      `[Run Change Journal — step ${this.currentStep} of 25]\n` +
      `This is an authoritative log of every file you touched this run.\n` +
      lines.join('\n')
    );
  }

  /** Paths of all files written or edited this run (deduplicated, preserving order). */
  getWrittenPaths(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const e of this.entries) {
      if ((e.operation === 'write' || e.operation === 'edit') && !seen.has(e.path)) {
        seen.add(e.path);
        result.push(e.path);
      }
    }
    return result;
  }
}
