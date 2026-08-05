import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Copy, Check } from 'lucide-react';
import { FileText } from 'lucide-react';
import agentLogo from '@/assets/ecgagent.png';

// ─── Code block ───────────────────────────────────────────────────────────────

const CodeBlock: React.FC<{ code: string; language?: string }> = ({ code, language }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="not-prose my-2.5 max-h-[52vh] rounded-lg overflow-hidden border border-white/[0.07] bg-[#0a0a0e]">
      <div className="sticky top-0 z-10 flex items-center justify-between px-3.5 py-1.5 bg-[#0f0f14] border-b border-white/[0.06]">
        <span className="text-[9px] text-white/30 font-mono tracking-widest uppercase select-none">
          {language || 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[9px] text-white/30 hover:text-white/70 transition-all duration-150 px-1.5 py-0.5 rounded hover:bg-white/[0.06]"
        >
          {copied
            ? <Check className="w-2.5 h-2.5 text-emerald-400" />
            : <Copy className="w-2.5 h-2.5" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="m-0 max-h-[calc(52vh-30px)] overflow-auto p-3.5 text-[11.5px] text-gray-200/90 font-mono leading-relaxed">
        <code>{code.trim()}</code>
      </pre>
    </div>
  );
};

const mdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  pre({ children }) {
    const child = React.Children.only(children) as React.ReactElement<{
      className?: string;
      children?: React.ReactNode;
    }>;
    const className = child?.props?.className ?? '';
    const match = /language-(\w+)/.exec(className);
    const code = String(child?.props?.children ?? '').replace(/\n$/, '');
    return <CodeBlock code={code} language={match?.[1]} />;
  },
  code({ children }) {
    return (
      <code className="not-prose px-1 py-0.5 rounded bg-indigo-500/[0.1] text-[0.82em] text-indigo-300/90 font-mono border border-indigo-500/[0.15]">
        {children}
      </code>
    );
  },
  table({ children }) {
    return (
      <div className="not-prose my-2.5 max-h-[48vh] overflow-auto rounded-lg border border-white/[0.07] bg-white/[0.02]">
        <table className="w-full text-xs">{children}</table>
      </div>
    );
  },
};

// ─── Attachment type ──────────────────────────────────────────────────────────
interface MessageAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  previewUrl: string;
  category: 'image' | 'document';
}

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  status?: 'pending' | 'streaming' | 'complete' | 'error';
  attachments?: MessageAttachment[];
}

// ─── Component ────────────────────────────────────────────────────────────────

export const ChatMessage: React.FC<ChatMessageProps> = ({ role, content, status, attachments }) => {

  // ── User bubble ──────────────────────────────────────────────────────────────
  if (role === 'user') {
    return (
      <div className="flex justify-end animate-msg-appear">
        <div className="max-w-[82%] group">
          {attachments && attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5 justify-end">
              {attachments.map((att) =>
                att.category === 'image' ? (
                  <div key={att.id} className="rounded-xl overflow-hidden ring-1 ring-white/10">
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="h-20 max-w-[160px] object-cover"
                    />
                  </div>
                ) : (
                  <div
                    key={att.id}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-gray-400"
                  >
                    <FileText className="h-3.5 w-3.5 text-gray-500 shrink-0" />
                    <span className="truncate max-w-[110px]">{att.name}</span>
                  </div>
                )
              )}
            </div>
          )}
          {content && (
            <div className="relative px-3.5 py-2.5 rounded-2xl rounded-tr-sm
              bg-primary/[0.14]
              border border-primary/[0.2]
              text-[12.5px] text-gray-100 leading-[1.65] whitespace-pre-wrap break-words">
              {content}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Assistant pending   three-dot thinking ────────────────────────────────────
  if (status === 'pending') {
    return (
      <div className="flex items-start gap-2 animate-msg-appear">
        <AvatarBadge thinking />
        <div className="flex items-center gap-1 h-6 px-1">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400/60 animate-thinking-1" />
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400/60 animate-thinking-2" />
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400/60 animate-thinking-3" />
        </div>
      </div>
    );
  }

  // ── Assistant error ───────────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div className="flex items-start gap-2 animate-msg-appear">
        <AvatarBadge error />
        <div className="flex-1 min-w-0 px-3.5 py-2 rounded-xl rounded-tl-sm
          bg-red-500/[0.06] border border-red-500/[0.15] text-[12px] text-red-400/80 leading-relaxed">
          {content}
        </div>
      </div>
    );
  }

  // ── Assistant streaming / complete ────────────────────────────────────────────
  const isStreaming = status === 'streaming';
  // Before any text has arrived, show the same three-dot "thinking" language as the
  // pending state instead of a second, differently-worded status line   the detailed
  // headline (what file, how long) lives once, in AgentChatPanel's status ticker below.
  const showThinkingDots = isStreaming && !content.trim();

  return (
    <div className="flex items-start gap-2 animate-msg-appear">
      <AvatarBadge streaming={isStreaming} />

      {/* Pulsing left accent   sits outside the content box so it's never clipped */}
      {isStreaming && (
        <div
          aria-hidden="true"
          className="w-[2px] self-stretch rounded-full shrink-0 animate-stream-border"
          style={{
            background: 'linear-gradient(180deg, #a78bfa 0%, #6366f1 55%, transparent 100%)',
          }}
        />
      )}

      <div className="flex-1 min-w-0 relative">
        <div className={isStreaming ? 'animate-fade-in-stream' : ''}>
          {showThinkingDots ? (
            <div className="flex items-center gap-1 h-6 px-1">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400/60 animate-thinking-1" />
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400/60 animate-thinking-2" />
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400/60 animate-thinking-3" />
            </div>
          ) : (
            <MarkdownBody content={content} />
          )}
        </div>

        {/* Premium gradient cursor with glow */}
        {isStreaming && (
          <span
            className="inline-block w-[2.5px] h-[15px] rounded-full ml-0.5 animate-cursor-glow align-middle"
            style={{
              background: 'linear-gradient(180deg, #c4b5fd 0%, #818cf8 100%)',
            }}
          />
        )}
      </div>
    </div>
  );
};

export default ChatMessage;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function AvatarBadge({ error = false, streaming = false, thinking = false }: {
  error?: boolean; streaming?: boolean; thinking?: boolean;
}) {
  if (error) {
    return (
      <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5
        bg-red-600/20 border border-red-500/30">
        <span className="text-[8px] font-bold text-red-400">!</span>
      </div>
    );
  }

  return (
    <div className={`w-5 h-5 shrink-0 mt-0.5 overflow-hidden transition-opacity duration-300 ${thinking ? 'opacity-60 animate-pulse' : 'opacity-100'}`}>
      <img src={agentLogo} alt="Agent" className="w-full h-full object-contain" />
    </div>
  );
}

function MarkdownBody({ content }: { content: string }) {
  return (
    <div
      className={`
        prose prose-sm prose-invert max-w-none
        prose-p:text-[12.5px] prose-p:text-gray-200/90 prose-p:leading-[1.7] prose-p:my-1.5 first:prose-p:mt-0 last:prose-p:mb-0
        prose-headings:text-white prose-headings:font-semibold
        prose-h1:text-[14px] prose-h1:mt-3 prose-h1:mb-1.5 prose-h1:tracking-tight
        prose-h2:text-[13px] prose-h2:mt-2.5 prose-h2:mb-1
        prose-h3:text-[12px] prose-h3:mt-2 prose-h3:mb-1 prose-h3:text-white/80
        prose-ul:my-1.5 prose-ul:pl-3.5
        prose-ol:my-1.5 prose-ol:pl-3.5
        prose-li:text-[12px] prose-li:text-gray-200/85 prose-li:my-0
        prose-li:marker:text-indigo-400/50
        prose-strong:text-white prose-strong:font-semibold
        prose-em:text-gray-300 prose-em:italic
        prose-a:text-indigo-400/90 prose-a:no-underline hover:prose-a:underline prose-a:underline-offset-2
        prose-blockquote:border-l-2 prose-blockquote:border-indigo-500/40 prose-blockquote:text-gray-400 prose-blockquote:not-italic prose-blockquote:pl-3 prose-blockquote:py-0.5 prose-blockquote:my-2
        prose-hr:border-white/[0.07] prose-hr:my-3
        prose-table:text-xs
        prose-th:text-gray-400 prose-th:bg-white/[0.03] prose-th:font-medium prose-th:text-[11px]
        prose-td:text-gray-300 prose-td:text-[11px]
        prose-thead:border-b prose-thead:border-white/[0.07]
        prose-tr:border-b prose-tr:border-white/[0.04]
      `}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={mdComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
