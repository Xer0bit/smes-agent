import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bot, RotateCcw, ChevronDown } from 'lucide-react';
import { chat } from '../lib/ecgClient';
import { ECG } from '../ecg-config';

type Role = 'user' | 'assistant';
type Action = { tool: string; result: unknown };
type Message = { role: Role; content: string; actions?: Action[] };

const SUGGESTIONS = [
  'What agents do I have and what are they doing?',
  'Show me posts that need approval',
  'What ran recently and did anything fail?',
  'Give me a summary of my portal activity',
];

const TOOL_LABELS: Record<string, string> = {
  list_agents: 'Listed agents',
  list_posts: 'Listed posts',
  approve_post: 'Approved post',
  reject_post: 'Rejected post',
  list_runs: 'Listed runs',
  list_schedulers: 'Listed schedulers',
  list_connectors: 'Listed connectors',
  list_knowledge: 'Listed knowledge',
};

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, []);

  async function send(text: string = input) {
    const msg = text.trim();
    if (!msg || loading) return;
    const next: Message[] = [...messages, { role: 'user', content: msg }];
    setMessages(next);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setLoading(true);
    setError('');
    try {
      const { reply, actions } = await chat(next.map(m => ({ role: m.role, content: m.content })));
      setMessages(p => [...p, { role: 'assistant', content: reply, actions: actions?.length ? actions : undefined }]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setMessages([]);
    setError('');
    setInput('');
  }

  const empty = messages.length === 0;

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--body-bg)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--accent)' }}>
            <Bot className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{ECG.appName} Assistant</h1>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>Powered by eCG Agents Portal</p>
          </div>
        </div>
        {!empty && (
          <button onClick={reset} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors hover:opacity-80"
            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
            <RotateCcw className="w-3 h-3" /> New chat
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {empty ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center h-full gap-8 px-6 py-12">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
                style={{ background: 'var(--accent)' }}>
                <Bot className="w-8 h-8 text-white" />
              </div>
              <h2 className="text-2xl font-semibold mb-2" style={{ color: 'var(--text)' }}>
                How can I help?
              </h2>
              <p className="text-sm max-w-sm" style={{ color: 'var(--muted)' }}>
                Ask about your agents, review content, check run history, or take actions — I have access to your portal.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-xl">
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => send(s)}
                  className="text-left text-sm px-4 py-3 rounded-xl border transition-colors hover:opacity-80"
                  style={{ borderColor: 'var(--border)', background: 'var(--card-bg)', color: 'var(--text)' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto w-full px-4 py-6 space-y-6">
            {messages.map((m, i) => (
              <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {m.role === 'assistant' && (
                  <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center mt-0.5"
                    style={{ background: 'var(--accent)' }}>
                    <Bot className="w-4 h-4 text-white" />
                  </div>
                )}
                <div className="flex flex-col gap-2 max-w-[80%]">
                  {m.role === 'user' ? (
                    <div className="px-4 py-2.5 rounded-2xl rounded-tr-sm text-sm leading-relaxed text-white"
                      style={{ background: 'var(--accent)' }}>
                      {m.content}
                    </div>
                  ) : (
                    <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text)' }}>
                      {m.content}
                    </div>
                  )}
                  {m.actions && m.actions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {m.actions.map((a, j) => (
                        <span key={j}
                          className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium"
                          style={{ background: 'var(--accent-bg, #ede9fe)', color: 'var(--accent)' }}>
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                          {TOOL_LABELS[a.tool] ?? a.tool.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex gap-3 justify-start">
                <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center"
                  style={{ background: 'var(--accent)' }}>
                  <Bot className="w-4 h-4 text-white" />
                </div>
                <div className="flex items-center gap-1 pt-2">
                  {[0, 1, 2].map(i => (
                    <span key={i} className="w-2 h-2 rounded-full animate-bounce"
                      style={{ background: 'var(--muted)', animationDelay: `${i * 150}ms` }} />
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div className="text-sm text-center px-4 py-2 rounded-lg"
                style={{ background: '#fef2f2', color: '#dc2626' }}>
                {error}
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 px-4 pb-4 pt-2">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-end gap-2 rounded-2xl border px-4 py-3 shadow-sm"
            style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => { setInput(e.target.value); autoResize(); }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Ask about your agents, posts, runs…"
              rows={1}
              className="flex-1 resize-none bg-transparent text-sm outline-none leading-relaxed"
              style={{ color: 'var(--text)', maxHeight: '160px' }}
            />
            <button onClick={() => send()} disabled={!input.trim() || loading}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-white shrink-0 transition-opacity disabled:opacity-30"
              style={{ background: 'var(--accent)' }}>
              <Send className="w-4 h-4" />
            </button>
          </div>
          <p className="text-center text-xs mt-2" style={{ color: 'var(--muted)' }}>
            Enter to send · Shift+Enter for new line · Actions are performed on your behalf
          </p>
        </div>
      </div>
    </div>
  );
}
