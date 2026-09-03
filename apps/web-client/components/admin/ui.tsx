/**
 * Minimal admin kit. Every admin page is built from these five pieces so the
 * whole portal reads the same way: title + actions, a row of numbers, panels,
 * plain tables. No descriptions, no decoration.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between h-8">
        <h1 className="text-sm font-semibold text-white">{title}</h1>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Stats({ items }: { items: Array<{ label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'bad' }> }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
      {items.map((s) => (
        <div key={s.label} className="border border-white/10 rounded-md px-3 py-2">
          <div className="text-[11px] text-gray-500">{s.label}</div>
          <div className={cn('text-lg font-semibold', s.tone === 'bad' ? 'text-red-400' : s.tone === 'warn' ? 'text-amber-400' : s.tone === 'ok' ? 'text-emerald-400' : 'text-white')}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}

export function Panel({ title, actions, children, className }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('border border-white/10 rounded-md', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between px-3 h-9 border-b border-white/10">
          <h2 className="text-xs font-medium text-gray-300">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Plain table. Pass header labels; render <tr> rows as children. */
export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: string }) {
  const rows = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[11px] text-gray-500">
            {head.map((h, i) => <th key={i} className={cn('font-medium px-3 py-2', i === head.length - 1 && h === '' && 'text-right')}>{h}</th>)}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-t [&>tr]:border-white/[0.06] [&>tr:hover]:bg-white/[0.02] [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle text-gray-200">
          {rows.length === 0 ? <tr><td colSpan={head.length} className="text-center text-gray-500 py-8">{empty ?? 'Nothing here'}</td></tr> : rows}
        </tbody>
      </table>
    </div>
  );
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'off' }) {
  return <span className={cn('inline-block h-2 w-2 rounded-full', tone === 'ok' ? 'bg-emerald-400' : tone === 'warn' ? 'bg-amber-400' : tone === 'bad' ? 'bg-red-400' : 'bg-gray-600')} />;
}

export function Tag({ children, tone = 'gray' }: { children: ReactNode; tone?: 'gray' | 'accent' | 'ok' | 'warn' | 'bad' }) {
  const c = { gray: 'text-gray-300 border-white/15', accent: 'text-indigo-300 border-indigo-500/40', ok: 'text-emerald-300 border-emerald-500/40', warn: 'text-amber-300 border-amber-500/40', bad: 'text-red-300 border-red-500/40' }[tone];
  return <span className={cn('inline-block text-[11px] leading-5 px-1.5 rounded border', c)}>{children}</span>;
}

export const btn = {
  primary: 'h-8 px-3 rounded-md text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50',
  ghost: 'h-8 px-3 rounded-md text-xs font-medium border border-white/10 hover:bg-white/5 text-gray-200 disabled:opacity-50',
  icon: 'h-7 w-7 inline-flex items-center justify-center rounded-md text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-50',
  danger: 'h-8 px-3 rounded-md text-xs font-medium border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-50',
};

export const input = 'h-8 w-full rounded-md border border-white/10 bg-transparent px-2 text-xs text-white placeholder:text-gray-600 focus:outline-none focus:border-indigo-500/60';

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
