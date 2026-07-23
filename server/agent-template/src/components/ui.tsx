// Shared UI primitives  every page uses these instead of hand-rolled
// headers/spinners/empty states. All colors ride the theme CSS variables,
// never hardcoded values, so every theme + custom accent styles them.
import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';

export function PageHeader({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 pb-1">
      <div>
        {eyebrow && (
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>{eyebrow}</p>
        )}
        <h1 className="text-xl mt-0.5" style={{ color: 'var(--text)', fontWeight: 'var(--font-weight-heading)' }}>{title}</h1>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Card({ children, className = '', hover = false }: { children: ReactNode; className?: string; hover?: boolean }) {
  return (
    <div
      className={`rounded-xl border ${hover ? 'ecg-card-hover' : ''} ${className}`}
      style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-sm)' }}
    >
      {children}
    </div>
  );
}

export function EmptyState({ Icon, title, hint, action }: { Icon: LucideIcon; title: string; hint?: string; action?: ReactNode }) {
  return (
    <Card className="py-14 px-6 text-center">
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full" style={{ background: 'var(--accent-bg)' }}>
        <Icon className="w-5 h-5" style={{ color: 'var(--accent)' }} />
      </div>
      <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>{title}</p>
      {hint && <p className="mt-1 text-xs max-w-sm mx-auto" style={{ color: 'var(--muted)' }}>{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </Card>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <span
        className="w-5 h-5 rounded-full animate-spin border-2"
        style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent)' }}
      />
    </div>
  );
}

export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-12 rounded-xl border animate-pulse"
          style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', opacity: 1 - i * 0.15 }} />
      ))}
    </div>
  );
}

// Shared platform brand colors + labels. Used anywhere a platform needs a
// dot/bar/legend color (Dashboard chart, calendar day pills, connectors).
export const PLATFORM_META: Record<string, { label: string; bar: string }> = {
  linkedin:  { label: 'LinkedIn',  bar: '#0077B5' },
  facebook:  { label: 'Facebook',  bar: '#1877F2' },
  instagram: { label: 'Instagram', bar: '#E1306C' },
  x:         { label: 'X',         bar: '#64748b' },
  twitter:   { label: 'X',         bar: '#64748b' },
  youtube:   { label: 'YouTube',   bar: '#FF0000' },
  tiktok:    { label: 'TikTok',    bar: '#69C9D0' },
  whatsapp:  { label: 'WhatsApp',  bar: '#25D366' },
  threads:   { label: 'Threads',   bar: '#334155' },
  pinterest: { label: 'Pinterest', bar: '#E60023' },
  telegram:  { label: 'Telegram',  bar: '#229ED9' },
};
export function platformMeta(p: string) {
  return PLATFORM_META[p.toLowerCase()] ?? { label: p, bar: 'var(--muted)' };
}

// "3h ago" / "in 2d"  compact relative time for last-run / scheduled-at.
export function relTime(iso?: string | null): string {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const unit = abs < 3_600_000 ? [Math.max(1, Math.round(abs / 60_000)), 'm'] as const
    : abs < 86_400_000 ? [Math.round(abs / 3_600_000), 'h'] as const
    : [Math.round(abs / 86_400_000), 'd'] as const;
  return diff < 0 ? `${unit[0]}${unit[1]} ago` : `in ${unit[0]}${unit[1]}`;
}
