import React, { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Copy, Check } from 'lucide-react';
import { FileText } from 'lucide-react';

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

/**
 * Memoised: the panel re-renders on every streamed chunk, and each render used
 * to re-parse the markdown of EVERY message in the list, not just the one
 * still streaming. Props are primitives plus a stable attachments array, so a
 * shallow compare is exact.
 */
export const ChatMessage = memo(function ChatMessage({ role, content, status, attachments }: ChatMessageProps) {

  // ── User bubble ──────────────────────────────────────────────────────────────
  if (role === 'user') {
    return (
      <div className="flex justify-end animate-msg-appear">
        <div className="max-w-[85%]">
          {attachments && attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5 justify-end">
              {attachments.map((att) =>
                att.category === 'image' ? (
                  <div key={att.id} className="rounded-lg overflow-hidden ring-1 ring-white/10">
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
            <div className="px-3.5 py-2 rounded-2xl bg-white/[0.06] text-[13px] text-gray-100 leading-[1.6] whitespace-pre-wrap break-words">
              {content}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Assistant: waiting for the first token ──────────────────────────────────
  // No avatar, no gutter: the reply renders full-width like a document, and
  // the only signal that something is happening is these dots, in the exact
  // spot the first line of text will land.
  const waiting = status === 'pending' || (status === 'streaming' && !content.trim());
  if (waiting) {
    return (
      <div className="flex items-center gap-1 h-6 animate-msg-appear" aria-label="Thinking">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400/70 animate-thinking-1" />
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400/70 animate-thinking-2" />
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400/70 animate-thinking-3" />
      </div>
    );
  }

  // ── Assistant error ───────────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div className="animate-msg-appear px-3 py-2 rounded-lg border-l-2 border-red-400/60 bg-red-500/[0.05] text-[12.5px] text-red-300/90 leading-relaxed">
        {content}
      </div>
    );
  }

  // ── Assistant text ────────────────────────────────────────────────────────────
  // Streaming and complete render identically. Text arriving from the network
  // is its own progress indicator; the cursor, the pulsing side bar and the
  // per-paragraph blur reveal that used to accompany it were three animations
  // competing for the same 380px, and the cursor sat on its own line under
  // the text because it was a sibling of the markdown block, not part of it.
  return (
    <div className="animate-msg-appear min-w-0">
      <MarkdownBody content={content} />
    </div>
  );
});

export default ChatMessage;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function MarkdownBody({ content }: { content: string }) {
  return (
    <div
      className={`
        prose prose-sm prose-invert max-w-none
        prose-p:text-[13px] prose-p:text-gray-200/90 prose-p:leading-[1.65] prose-p:my-2 first:prose-p:mt-0 last:prose-p:mb-0
        prose-headings:text-white prose-headings:font-semibold
        prose-h1:text-[14px] prose-h1:mt-3 prose-h1:mb-1.5 prose-h1:tracking-tight
        prose-h2:text-[13.5px] prose-h2:mt-3 prose-h2:mb-1
        prose-h3:text-[13px] prose-h3:mt-2.5 prose-h3:mb-1 prose-h3:text-white/85
        prose-ul:my-2 prose-ul:pl-4
        prose-ol:my-2 prose-ol:pl-4
        prose-li:text-[13px] prose-li:text-gray-200/85 prose-li:my-0.5
        prose-li:marker:text-gray-500
        prose-strong:text-white prose-strong:font-semibold
        prose-em:text-gray-300 prose-em:italic
        prose-a:text-indigo-300 prose-a:no-underline hover:prose-a:underline prose-a:underline-offset-2
        prose-blockquote:border-l-2 prose-blockquote:border-white/15 prose-blockquote:text-gray-400 prose-blockquote:not-italic prose-blockquote:pl-3 prose-blockquote:py-0.5 prose-blockquote:my-2
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
