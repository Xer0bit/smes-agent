// Shared UI primitives  every page uses these instead of hand-rolled
// headers/spinners/empty states. All colors ride the theme CSS variables,
// never hardcoded values, so every theme + custom accent styles them.
import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';

export const DAYS_OF_WEEK = [
  { label: 'Mon', value: '1' }, { label: 'Tue', value: '2' }, { label: 'Wed', value: '3' },
  { label: 'Thu', value: '4' }, { label: 'Fri', value: '5' }, { label: 'Sat', value: '6' }, { label: 'Sun', value: '0' },
];
export function buildWeeklyCron(days: string[], hour: number): string {
  const sorted = [...days].sort((a, b) => Number(a) - Number(b));
  return `0 ${hour} * * ${sorted.join(',')}`;
}
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// "Mon, Wed, Fri at 09:00" instead of raw cron. Falls back to the raw
// string for any cron shape the weekly builder didn't produce.
export function cadenceSentence(cron?: string, postCount?: number): string | null {
  if (!cron) return null;
  const m = /^0 (\d{1,2}) \* \* ([\d,]+)$/.exec(cron.trim());
  if (!m) return null;
  const days = m[2].split(',').map(d => DAY_NAMES[Number(d)] ?? d).join(', ');
  const posts = postCount ? ` · ${postCount} post${postCount === 1 ? '' : 's'}` : '';
  return `${days} at ${String(m[1]).padStart(2, '0')}:00${posts}`;
}

// Always returns a plain-language string, never raw cron syntax -- for any
// schedule shape the weekly-builder regex above doesn't recognize (created
// outside this dashboard's own scheduler UI), fall back to a message instead
// of printing e.g. "0 9 * * 1,3,5" to a non-technical user.
export function cadenceLabel(cron?: string, postCount?: number): string {
  if (!cron) return 'No schedule set';
  return cadenceSentence(cron, postCount) ?? 'Custom schedule — edit in Schedulers';
}

export function PageHeader({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 pb-1">
      <div>
        {eyebrow && (
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--accent)' }}>{eyebrow}</p>
        )}
        <h1 className="text-2xl tracking-tight mt-0.5" style={{ color: 'var(--text)', fontWeight: 'var(--font-weight-heading)' }}>{title}</h1>
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

// Bigger icon badge with a soft glow ring behind it, dashed border on the
// card itself -- a true first-run "nothing here yet" state should read as
// designed, not as an accidental leftover card floating in empty gray space.
export function EmptyState({ Icon, title, hint, action }: { Icon: LucideIcon; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="relative rounded-xl border border-dashed py-16 px-6 text-center overflow-hidden"
      style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
      <div className="relative mx-auto mb-4 flex h-14 w-14 items-center justify-center">
        <div className="absolute inset-0 rounded-full blur-lg" style={{ background: 'var(--accent)', opacity: 0.18 }} />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-full" style={{ background: 'var(--accent-bg)' }}>
          <Icon className="w-6 h-6" style={{ color: 'var(--accent)' }} />
        </div>
      </div>
      <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{title}</p>
      {hint && <p className="mt-1.5 text-xs max-w-sm mx-auto" style={{ color: 'var(--muted)' }}>{hint}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

// Small accent-colored rule + title, used above every content panel so
// sections have a visual anchor instead of a bare <h3>.
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <span className="h-3.5 w-[3px] rounded-full" style={{ background: 'var(--accent)' }} />
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{title}</h3>
      </div>
      {action}
    </div>
  );
}

export type StatTone = 'accent' | 'warning' | 'success' | 'neutral';
// `color` drives the icon/bar; `chipBg` is a pre-computed tint -- can't string-
// concat an alpha suffix onto a `var(--x)` call (invalid CSS, silently dropped),
// so accent reuses the existing `--accent-bg` token and the fixed hex tones get
// their own literal rgba tint.
const STAT_TONE: Record<StatTone, { color: string; chipBg: string }> = {
  accent:  { color: 'var(--accent)', chipBg: 'var(--accent-bg)' },
  warning: { color: '#d97706', chipBg: 'rgba(217, 119, 6, 0.12)' },
  success: { color: '#16a34a', chipBg: 'rgba(22, 163, 74, 0.12)' },
  neutral: { color: 'var(--muted)', chipBg: 'rgba(100, 116, 139, 0.12)' },
};

// KPI tile with an icon chip, a top accent bar, and a large tabular-nums
// value -- replaces the bare label+icon+number blocks that made every stat
// card on the dashboard look identical regardless of what it meant.
export function StatCard({ label, value, Icon, tone = 'neutral', sub }: {
  label: string;
  value: ReactNode;
  Icon: LucideIcon;
  tone?: StatTone;
  sub?: ReactNode;
}) {
  const { color, chipBg } = STAT_TONE[tone];
  return (
    <div className="relative rounded-xl border overflow-hidden" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-sm)' }}>
      <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: color }} />
      <div className="p-4 pt-[18px]">
        <div className="flex items-center justify-between mb-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{label}</p>
          <div className="flex h-7 w-7 items-center justify-center rounded-lg shrink-0" style={{ background: chipBg }}>
            <Icon className="w-3.5 h-3.5" style={{ color }} />
          </div>
        </div>
        <p className="text-3xl font-bold tabular-nums tracking-tight" style={{ color: 'var(--text)' }}>{value}</p>
        {sub && <div className="mt-2">{sub}</div>}
      </div>
    </div>
  );
}

// Small circular progress ring for the setup checklist's "N/total" counter --
// reads as real progress, not a stray fraction of text.
export function ProgressRing({ done, total, size = 28 }: { done: number; total: number; size?: number }) {
  const r = (size - 4) / 2;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? done / total : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--accent)" strokeWidth="2.5"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct)} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fontSize="9" fontWeight="700" fill="var(--text)">
        {done}/{total}
      </text>
    </svg>
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

// Hard character limits per platform (mirrors queue-service/worker.ts's
// PLATFORM_LIMITS on the agent-portal side -- static, small enough to
// duplicate client-side rather than add a new endpoint just to read 11 numbers).
export const PLATFORM_CHAR_LIMIT: Record<string, number> = {
  linkedin: 3000, instagram: 2200, facebook: 63000, x: 280, twitter: 280,
  youtube: 5000, threads: 500, tiktok: 2200, pinterest: 800, telegram: 4096,
  whatsapp: 4096,
};
export function platformCharLimit(p: string): number {
  return PLATFORM_CHAR_LIMIT[p.toLowerCase()] ?? 5000;
}

// Shared by AgentsPage.tsx and EditAgentPage.tsx: deleting an agent requires
// it be archived first (same rule the main org portal enforces). Both pages
// hit the identical backend error, so the archive-first recovery flow lives
// here once instead of two independently-drifting copies -- previously
// EditAgentPage had no handling for this at all and just surfaced a raw
// backend error with no way to recover.
export function AgentDeleteModal({ agentName, onClose, onConfirm, loading, blocked, onArchiveThenDelete }: {
  agentName: string;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
  blocked: boolean;
  onArchiveThenDelete: () => void;
}) {
  if (blocked) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Archive first</h2>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            <strong>{agentName}</strong> needs to be archived before it can be deleted. Archive and delete it now?
          </p>
          <div className="flex gap-3 pt-2">
            <button onClick={onClose} disabled={loading} className="flex-1 px-4 py-2 rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
              Cancel
            </button>
            <button onClick={onArchiveThenDelete} disabled={loading} className="flex-1 px-4 py-2 rounded-lg text-white bg-red-600 hover:opacity-90 disabled:opacity-50">
              {loading ? 'Working…' : 'Archive & delete'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Delete Agent</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Are you sure you want to delete <strong>{agentName}</strong>? This action cannot be undone.
        </p>
        <div className="flex gap-3 pt-2">
          <button onClick={onClose} disabled={loading} className="flex-1 px-4 py-2 rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
            Cancel
          </button>
          <button onClick={onConfirm} disabled={loading} className="flex-1 px-4 py-2 rounded-lg text-white bg-red-600 disabled:opacity-50">
            {loading ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Auto-detect the browser's timezone instead of defaulting everyone to UTC --
// falls back to 'UTC' if Intl throws (very old browsers). Used by Create/Edit
// Agent's timezone picker; callers should add the result to their options
// list if it isn't already one of their hardcoded zones, so the <select>
// always has a matching option instead of silently showing the wrong value.
export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
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
