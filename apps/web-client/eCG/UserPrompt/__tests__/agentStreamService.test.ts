import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../integrations/supabase/client', () => ({
  lovableCloud: {
    auth: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock('../../../config/external-api', () => ({
  getGenServerCandidateUrls: vi.fn(() => ['http://localhost:4000/api/v1/ai/agent-stream']),
}));

import { lovableCloud } from '../../../integrations/supabase/client';
import { streamAgentGeneration } from '../agentStreamService';

describe('agentStreamService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(lovableCloud.auth.getSession).mockResolvedValue({
      data: { session: { access_token: 'mock-token' } },
    } as any);
    global.fetch = vi.fn();
  });

  it('parses a normal done event', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode([
          'event: text-delta\n',
          'data: {"text":"Building app"}\n\n',
          'event: done\n',
          'data: {"filesToWrite":[{"path":"src/App.tsx","content":"export default function App() { return null; }"}],"summary":"Built app","tokensUsed":123,"mode":"build"}\n\n',
        ].join('')));
        controller.close();
      },
    });

    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      body: stream,
    } as Response);

    const onDone = vi.fn();
    const onTextDelta = vi.fn();

    const result = await streamAgentGeneration({
      prompt: 'Build app',
      projectId: 'project-123',
      callbacks: { onDone, onTextDelta },
    });

    expect(onTextDelta).toHaveBeenCalledWith('Building app');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.filesToWrite).toEqual([
      expect.objectContaining({ path: 'src/App.tsx' }),
    ]);
    expect(result.summary).toBe('Built app');
    expect(result.tokensUsed).toBe(123);
    expect(result.mode).toBe('build');
  });

  it('synthesizes completion when the stream closes without done', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode([
          'event: text-delta\n',
          'data: {"text":"<SMEsAgent-chat-summary>Created pricing dashboard</SMEsAgent-chat-summary>"}\n\n',
          'event: tool-output\n',
          'data: {"xml":"<SMEsAgent-write path=\\"src/App.tsx\\">export default function App() { return null; }</SMEsAgent-write>"}\n\n',
        ].join('')));
        controller.close();
      },
    });

    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      body: stream,
    } as Response);

    const onDone = vi.fn();
    const onError = vi.fn();

    const result = await streamAgentGeneration({
      prompt: 'Build app',
      projectId: 'project-123',
      callbacks: { onDone, onError },
    });

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.filesToWrite).toEqual([
      expect.objectContaining({ path: 'src/App.tsx' }),
    ]);
    expect(result.summary).toBe('Created pricing dashboard');
    expect(result.tokensUsed).toBe(0);
    expect(result.mode).toBe('build');
  });
});

/**
 * The request body must not carry the project's source.
 *
 * agentLoopService snapshots /var/SMEsAgent/projects/<projectId> on every run and
 * that disk state is authoritative. A non-empty existingFiles in the body
 * OVERRIDES it (fileSources prefers the client array), so shipping it both
 * uploaded the whole tree on every message and let a stale browser snapshot
 * decide what the agent thinks is on disk.
 *
 * Callers still pass existingFiles -- promptService seeds its local liveFileMap
 * from it -- so the param staying in the signature is not evidence it is unsent.
 * Only the serialized body proves that, which is what these assert.
 */
describe('agent-stream request body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(lovableCloud.auth.getSession).mockResolvedValue({
      data: { session: { access_token: 'mock-token' } },
    } as any);
    global.fetch = vi.fn();
  });

  const bodyOf = (call: unknown[]): Record<string, unknown> =>
    JSON.parse((call[1] as RequestInit).body as string);

  const emptyStream = () => new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: done\ndata: {"filesToWrite":[]}\n\n'));
      controller.close();
    },
  });

  it('omits existingFiles even when the caller supplies a full tree', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: true, body: emptyStream() } as Response);

    await streamAgentGeneration({
      prompt: 'tweak the header',
      projectId: 'project-123',
      existingFiles: Array.from({ length: 193 }, (_, i) => ({
        path: `src/File${i}.tsx`,
        content: 'x'.repeat(2000),
      })) as never,
      callbacks: {},
    });

    const body = bodyOf(vi.mocked(global.fetch).mock.calls[0]);
    expect(body).not.toHaveProperty('existingFiles');
    // 193 * 2KB would be ~400KB; the body must stay small regardless of project size.
    expect(JSON.stringify(body).length).toBeLessThan(4096);
  });

  it('still sends the fields the server actually needs', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: true, body: emptyStream() } as Response);

    await streamAgentGeneration({
      prompt: 'tweak the header',
      projectId: 'project-123',
      chatMode: 'admin',
      mode: 'plan',
      history: [{ role: 'user', content: 'earlier turn' }],
      olderSummary: 'summary of older turns',
      callbacks: {},
    });

    const body = bodyOf(vi.mocked(global.fetch).mock.calls[0]);
    expect(body.prompt).toBe('tweak the header');
    expect(body.projectId).toBe('project-123');
    expect(body.chatMode).toBe('admin');
    expect(body.mode).toBe('plan');
    expect(body.history).toEqual([{ role: 'user', content: 'earlier turn' }]);
    expect(body.olderSummary).toBe('summary of older turns');
  });
});
