/**
 * Verifies the step-cap extension to needsAutoContinue (harness redesign
 * checkpoint 6, 2026-08-13): a run that hits MAX_STEPS (not the token/cost
 * cap) with real progress and no stuck signal now sets needsAutoContinue,
 * same as the pre-existing budget-cap case -- see agentLoopService.ts's
 * `hitStepCap` / `needsAutoContinue` computation.
 *
 * Drives the REAL `runAgentLoop` export end-to-end. Only `streamText` is
 * replaced: each test feeds it a scripted sequence of onStepFinish calls
 * (the same closure the real AI SDK would call once per step) so stepCount,
 * anySuccessfulWriteThisRun, budgetAbortReason, and stuckAnalysisAbortReason
 * are all mutated by the real production code, not reimplemented here.
 * `write_file`'s actual `.execute()` is deliberately never invoked (only its
 * onStepFinish-visible bookkeeping is faked) so the run takes the
 * `!agentWroteFiles` branch and never attempts a real preview-service push.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AI_ANTHROPIC_API_KEY = process.env.AI_ANTHROPIC_API_KEY || 'test-anthropic-key';

// Same module-load requirement as agentLoopService.scopeSeeding.test.ts:
// agentLoopService.ts -> agentToolSet.ts -> propose_plan.ts -> config/database.js
// throws at import time if SUPABASE_URL/SUPABASE_SERVICE_KEY/SUPABASE_ANON_KEY
// are unset. agentLoopService.ts's own `supabase` client is separately
// null-guarded on SUPABASE_URL directly, so this mock does not affect it.
vi.mock('../../config/database.js', () => ({
  supabase: {},
  supabaseAuth: {},
  default: {},
}));

type StepFinishArgs = {
  text: string;
  toolCalls: Array<{ toolName: string; input: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; input: Record<string, unknown>; output: string }>;
  usage: { inputTokens: number; outputTokens: number };
  providerMetadata: Record<string, unknown>;
};

let scriptedSteps: StepFinishArgs[] = [];
let scriptedFinishReason = 'tool-calls';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(async () => {
      throw new Error('generateText should not be called for a micro-tier run in this fixture');
    }),
    streamText: vi.fn(async (streamParams: any) => {
      for (const step of scriptedSteps) {
        await streamParams.onStepFinish(step);
      }
      return {
        fullStream: (async function* () {
          yield { type: 'finish', finishReason: scriptedFinishReason };
        })(),
      };
    }),
  };
});

import { runAgentLoop, type AgentEventSink } from '../agentLoopService.js';

const writeStep = (path: string): StepFinishArgs => ({
  text: '',
  toolCalls: [{ toolName: 'write_file', input: { path } }],
  toolResults: [{ toolName: 'write_file', input: { path }, output: `Successfully wrote ${path}` }],
  usage: { inputTokens: 100, outputTokens: 50 },
  providerMetadata: {},
});

const emptyStep = (): StepFinishArgs => ({
  text: '',
  toolCalls: [],
  toolResults: [],
  usage: { inputTokens: 50, outputTokens: 20 },
  providerMetadata: {},
});

const thinkStep = (thought: string): StepFinishArgs => ({
  text: '',
  toolCalls: [{ toolName: 'think', input: { thought } }],
  toolResults: [{ toolName: 'think', input: { thought }, output: 'noted' }],
  usage: { inputTokens: 50, outputTokens: 20 },
  providerMetadata: {},
});

describe('agentLoopService needsAutoContinue step-cap extension (micro tier, MAX_STEPS=8)', () => {
  let tmpDir: string;
  const originalKeys = {
    AI_ANTHROPIC_API_KEY: process.env.AI_ANTHROPIC_API_KEY,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };

  beforeEach(() => {
    scriptedSteps = [];
    scriptedFinishReason = 'tool-calls';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecomgear-autocontinue-stepcap-'));
    delete process.env.ZAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalKeys)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('sets needsAutoContinue when a run hits MAX_STEPS with real progress and is not stuck', async () => {
    scriptedSteps = Array.from({ length: 8 }, (_, i) => writeStep(`src/gen-${i + 1}.tsx`));
    const events: Array<{ event: string; data: any }> = [];
    const sink: AgentEventSink = { emit: (event, data) => { events.push({ event, data }); }, heartbeat: () => {} };

    const result = await runAgentLoop({
      prompt: 'Add a small feature',
      projectId: 'autocontinue-stepcap-progress',
      appPath: tmpDir,
      mode: 'build',
      promptIntent: { requestTier: 'micro' },
      sink,
    });

    expect(result.needsAutoContinue).toBe(true);
    expect(result.continuationPrompt).toContain('Continue exactly where you left off');
    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent?.data.needsAutoContinue).toBe(true);
    expect(doneEvent?.data.continuationPrompt).toBe(result.continuationPrompt);
  }, 20_000);

  it('leaves the zero-files-written case unchanged: honest message, no needsAutoContinue', async () => {
    scriptedSteps = Array.from({ length: 8 }, () => emptyStep());
    const events: Array<{ event: string; data: any }> = [];
    const sink: AgentEventSink = { emit: (event, data) => { events.push({ event, data }); }, heartbeat: () => {} };

    const result = await runAgentLoop({
      prompt: 'Add a small feature',
      projectId: 'autocontinue-stepcap-zerofiles',
      appPath: tmpDir,
      mode: 'build',
      promptIntent: { requestTier: 'micro' },
      sink,
    });

    expect(result.needsAutoContinue).toBeFalsy();
    expect(result.continuationPrompt).toBeUndefined();
    const honestMessage = events.find(
      (e) => e.event === 'text-delta' && typeof e.data?.text === 'string' && e.data.text.includes('I ran out of steps before completing the changes'),
    );
    expect(honestMessage).toBeDefined();
  }, 20_000);

  it('does not set needsAutoContinue when the run is genuinely stuck, even with prior progress', async () => {
    const repeatedThought = 'Investigating the root cause of this issue in detail before making another change.';
    scriptedSteps = [
      writeStep('src/gen-1.tsx'),
      thinkStep(repeatedThought),
      thinkStep(repeatedThought),
      thinkStep(repeatedThought),
      thinkStep(repeatedThought),
      emptyStep(),
      emptyStep(),
      emptyStep(),
    ];
    const sink: AgentEventSink = { emit: () => {}, heartbeat: () => {} };

    const result = await runAgentLoop({
      prompt: 'Fix a bug',
      projectId: 'autocontinue-stepcap-stuck',
      appPath: tmpDir,
      mode: 'build',
      promptIntent: { requestTier: 'micro' },
      sink,
    });

    expect(result.stuckAborted).toBe(true);
    expect(result.needsAutoContinue).toBeFalsy();
    expect(result.continuationPrompt).toBeUndefined();
  }, 20_000);

  it('is unaffected by the widened condition when the existing token/cost cap fires (regression)', async () => {
    scriptedSteps = [
      {
        text: '',
        toolCalls: [{ toolName: 'write_file', input: { path: 'src/gen-1.tsx' } }],
        toolResults: [{ toolName: 'write_file', input: { path: 'src/gen-1.tsx' }, output: 'Successfully wrote src/gen-1.tsx' }],
        // Deliberately exceeds micro tier's RUN_TOKEN_CAP (160,000) in one
        // step so the existing budgetAbortReason path fires on its own,
        // independent of the new hitStepCap path (stepCount stays at 1,
        // nowhere near MAX_STEPS=8).
        usage: { inputTokens: 170_000, outputTokens: 1_000 },
        providerMetadata: {},
      },
    ];
    const sink: AgentEventSink = { emit: () => {}, heartbeat: () => {} };

    const result = await runAgentLoop({
      prompt: 'Add a small feature',
      projectId: 'autocontinue-stepcap-budgetcap-regression',
      appPath: tmpDir,
      mode: 'build',
      promptIntent: { requestTier: 'micro' },
      sink,
    });

    expect(result.needsAutoContinue).toBe(true);
    expect(result.continuationPrompt).toContain('Continue exactly where you left off');
  }, 20_000);
});
