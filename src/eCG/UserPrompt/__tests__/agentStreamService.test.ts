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
          'data: {"text":"<ecomgear-chat-summary>Created pricing dashboard</ecomgear-chat-summary>"}\n\n',
          'event: tool-output\n',
          'data: {"xml":"<ecomgear-write path=\\"src/App.tsx\\">export default function App() { return null; }</ecomgear-write>"}\n\n',
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
