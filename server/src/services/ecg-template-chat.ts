// Gemini-style floating dashboard chat and placeholder page generators.

export function dashboardChatTsx(): string {
  return `import { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, Minimize2, Bot, Loader2 } from 'lucide-react';

const SERVER = (import.meta.env.VITE_ECG_PROXY_URL || '').replace(/\\/$/, '');
const PROJECT_ID = import.meta.env.VITE_PROJECT_ID || '';

type Message = { role: 'user' | 'assistant'; content: string; actions?: { tool: string; result: unknown }[] };

export default function DashboardChat() {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && !minimized) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open, minimized]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next: Message[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setLoading(true);
    setError('');
    try {
      const res = await fetch(\`\${SERVER}/api/v1/ecg-chat?projectId=\${PROJECT_ID}\`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.map(m => ({ role: m.role, content: m.content })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setMessages(p => [...p, { role: 'assistant', content: data.reply, actions: data.actions }]);
    } catch (e: any) {
      setError(e.message ?? 'Failed to reach assistant');
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open AI assistant"
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-xl flex items-center justify-center text-white transition-transform hover:scale-105 active:scale-95"
        style={{ background: 'var(--accent, #4f46e5)' }}
      >
        <MessageCircle className="w-6 h-6" />
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex flex-col rounded-2xl shadow-2xl overflow-hidden"
      style={{
        width: '380px',
        height: minimized ? '56px' : '520px',
        background: 'var(--card-bg, #fff)',
        border: '1px solid var(--border, #e2e8f0)',
        transition: 'height 0.2s ease',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 h-14 shrink-0 cursor-pointer"
        style={{ background: 'var(--accent, #4f46e5)', color: '#fff' }}
        onClick={() => setMinimized(v => !v)}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <p className="text-sm font-semibold leading-none">Portal Assistant</p>
            <p className="text-xs opacity-70 mt-0.5">{loading ? 'Thinking…' : 'Ask me anything'}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={e => { e.stopPropagation(); setMinimized(v => !v); }} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
            <Minimize2 className="w-4 h-4" />
          </button>
          <button onClick={e => { e.stopPropagation(); setOpen(false); }} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {!minimized && (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-8">
                <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: 'var(--accent-light, #ede9fe)' }}>
                  <Bot className="w-6 h-6" style={{ color: 'var(--accent, #4f46e5)' }} />
                </div>
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text, #1e293b)' }}>How can I help?</p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted, #64748b)' }}>Ask about agents, posts, runs, or take actions.</p>
                </div>
                <div className="flex flex-wrap gap-2 justify-center mt-2">
                  {['List my agents', 'Show pending posts', 'Recent runs'].map(s => (
                    <button key={s} onClick={() => setInput(s)}
                      className="text-xs px-3 py-1.5 rounded-full border transition-colors"
                      style={{ borderColor: 'var(--border, #e2e8f0)', color: 'var(--text, #1e293b)' }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={\`flex \${m.role === 'user' ? 'justify-end' : 'justify-start'} gap-2\`}>
                {m.role === 'assistant' && (
                  <div className="w-6 h-6 rounded-full shrink-0 mt-0.5 flex items-center justify-center" style={{ background: 'var(--accent-light, #ede9fe)' }}>
                    <Bot className="w-3 h-3" style={{ color: 'var(--accent, #4f46e5)' }} />
                  </div>
                )}
                <div className={\`max-w-[78%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed \${m.role === 'user' ? 'text-white rounded-br-sm' : 'rounded-bl-sm'}\`}
                  style={m.role === 'user'
                    ? { background: 'var(--accent, #4f46e5)' }
                    : { background: 'var(--hover-bg, #f8fafc)', color: 'var(--text, #1e293b)', border: '1px solid var(--border, #e2e8f0)' }}>
                  {m.content}
                  {m.actions && m.actions.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-white/20 flex flex-wrap gap-1">
                      {m.actions.map((a, j) => (
                        <span key={j} className="text-xs px-2 py-0.5 rounded-full bg-white/20">{a.tool.replace(/_/g, ' ')}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex items-start gap-2">
                <div className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center" style={{ background: 'var(--accent-light, #ede9fe)' }}>
                  <Bot className="w-3 h-3" style={{ color: 'var(--accent, #4f46e5)' }} />
                </div>
                <div className="rounded-2xl rounded-bl-sm px-3.5 py-2.5 text-sm flex items-center gap-2"
                  style={{ background: 'var(--hover-bg, #f8fafc)', border: '1px solid var(--border, #e2e8f0)', color: 'var(--text-muted, #64748b)' }}>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking…
                </div>
              </div>
            )}

            {error && (
              <p className="text-xs text-red-500 text-center px-2">{error}</p>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="px-3 pb-3 pt-2 shrink-0" style={{ borderTop: '1px solid var(--border, #e2e8f0)' }}>
            <div className="flex gap-2 items-end rounded-xl px-3 py-2" style={{ background: 'var(--hover-bg, #f8fafc)', border: '1px solid var(--border, #e2e8f0)' }}>
              <textarea
                value={input}
                onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 96) + 'px'; }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Message Portal Assistant…"
                rows={1}
                className="flex-1 resize-none text-sm bg-transparent outline-none leading-relaxed"
                style={{ color: 'var(--text, #1e293b)', maxHeight: '96px' }}
              />
              <button onClick={send} disabled={!input.trim() || loading}
                className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-white transition-opacity disabled:opacity-40"
                style={{ background: 'var(--accent, #4f46e5)' }}>
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-center text-xs mt-1.5" style={{ color: 'var(--text-muted, #94a3b8)' }}>Enter to send · Shift+Enter for new line</p>
          </div>
        </>
      )}
    </div>
  );
}
`;
}

export function emptyPage(name: string, icon: string): string {
  return `import { ${icon} } from 'lucide-react';

export default function ${name.replace(/\s+/g, '')}Page() {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-slate-400">
      <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center">
        <${icon} className="w-7 h-7" />
      </div>
      <div className="text-center">
        <p className="font-medium text-slate-600">${name}</p>
        <p className="text-sm mt-1">No data available yet.</p>
      </div>
    </div>
  );
}
`;
}
