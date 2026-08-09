// Shared UI primitives  every page uses these instead of hand-rolled
// headers/spinners/empty states. All colors ride the theme CSS variables,
// never hardcoded values, so every theme + custom accent styles them.
import { ReactNode, useState } from 'react';
import { LucideIcon, X, Plus } from 'lucide-react';

// Shared by CreateAgentPage (set at agent creation) and EditAgentPage (edited
// after) -- one shape, one default, so the two harness UIs can't drift apart.
export interface Harness {
  historyWindow: number;
  avoidRepeats: boolean;
  topicsToAvoid: string[];
  focusTopics: string[];
}
export const DEFAULT_HARNESS: Harness = { historyWindow: 8, avoidRepeats: true, topicsToAvoid: [], focusTopics: [] };

// Editable tag list: type + Enter/comma to add, click x to remove.
export function TagInput({ tags, onChange, placeholder }: { tags: string[]; onChange: (t: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  function commit() {
    const v = draft.trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setDraft('');
  }
  return (
    <div className="border px-2 py-2 flex flex-wrap gap-1.5" style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', borderRadius: 'var(--radius-sm)' }}>
      {tags.map(t => (
        <span key={t} className="inline-flex items-center gap-1 px-2 py-1 rounded-full" style={{ fontSize: 'var(--text-tiny)', background: 'var(--accent-bg)', color: 'var(--text)' }}>
          {t}
          <button type="button" onClick={() => onChange(tags.filter(x => x !== t))} className="hover:opacity-70">
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
          if (e.key === 'Backspace' && !draft && tags.length > 0) onChange(tags.slice(0, -1));
        }}
        onBlur={commit}
        placeholder={tags.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[8rem] bg-transparent focus:outline-none"
        style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}
      />
      {draft.trim() && (
        <button type="button" onClick={commit} className="p-1 rounded hover:opacity-70" style={{ color: 'var(--accent)' }}>
          <Plus className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

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
          <p style={{ fontSize: 'var(--text-tiny)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 'var(--tracking-wide)', color: 'var(--accent)' }}>{eyebrow}</p>
        )}
        {/* font-size/weight/tracking come from index.css's global h1 rule (design.md's type scale) -- only color is set here. */}
        <h1 style={{ color: 'var(--text)', marginTop: '0.125rem' }}>{title}</h1>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Card({ children, className = '', hover = false }: { children: ReactNode; className?: string; hover?: boolean }) {
  return (
    <div
      className={`border ${hover ? 'ecg-card-hover' : ''} ${className}`}
      style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-sm)', borderRadius: 'var(--radius)' }}
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
    <div className="relative border border-dashed py-16 px-6 text-center overflow-hidden"
      style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', borderRadius: 'var(--radius)' }}>
      <div className="relative mx-auto mb-4 flex h-14 w-14 items-center justify-center">
        <div className="absolute inset-0 rounded-full blur-lg" style={{ background: 'var(--accent)', opacity: 0.18 }} />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-full" style={{ background: 'var(--accent-bg)' }}>
          <Icon className="w-6 h-6" style={{ color: 'var(--accent)' }} />
        </div>
      </div>
      <p style={{ fontSize: 'var(--text-body)', fontWeight: 600, color: 'var(--text)' }}>{title}</p>
      {hint && <p className="mt-1.5 max-w-sm mx-auto" style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>{hint}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

// Small accent-colored rule + title, used above every content panel so
// sections have a visual anchor instead of a bare <h3>. Deliberately NOT a
// real <h3> element -- index.css's global h3 rule sizes real headings at
// --text-h3 (20px), which would be much too loud for a small section label;
// this is styled explicitly at --text-body instead.
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <span className="h-3.5 w-[3px] rounded-full" style={{ background: 'var(--accent)' }} />
        <p style={{ fontSize: 'var(--text-body)', fontWeight: 600, color: 'var(--text)' }}>{title}</p>
      </div>
      {action}
    </div>
  );
}

export type StatTone = 'accent' | 'warning' | 'success' | 'neutral';
// `color`/`chipBg` now read the reserved status tokens from design.md (emitted
// by cssVars() in ecg-template.ts) instead of hardcoding hex literals here --
// a warning/success/danger color used to be duplicated ad hoc in several
// components; this is the one place per tone now.
const STAT_TONE: Record<StatTone, { color: string; chipBg: string }> = {
  accent:  { color: 'var(--accent)', chipBg: 'var(--accent-bg)' },
  warning: { color: 'var(--warning)', chipBg: 'var(--warning-bg)' },
  success: { color: 'var(--success)', chipBg: 'var(--success-bg)' },
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
    <div className="relative border overflow-hidden" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-sm)', borderRadius: 'var(--radius)' }}>
      <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: color }} />
      <div className="p-4 pt-[18px]">
        <div className="flex items-center justify-between mb-2.5">
          <p style={{ fontSize: 'var(--text-tiny)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 'var(--tracking-wide)', color: 'var(--muted)' }}>{label}</p>
          <div className="flex h-7 w-7 items-center justify-center shrink-0" style={{ background: chipBg, borderRadius: 'var(--radius-sm)' }}>
            <Icon className="w-3.5 h-3.5" style={{ color }} />
          </div>
        </div>
        <p className="tabular-nums" style={{ fontSize: 'var(--text-h1)', fontWeight: 700, letterSpacing: 'var(--tracking-tight)', color: 'var(--text)' }}>{value}</p>
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
  bluesky:   { label: 'Bluesky',   bar: '#0085FF' },
};
export function platformMeta(p: string) {
  return PLATFORM_META[p.toLowerCase()] ?? { label: p, bar: 'var(--muted)' };
}

// Hard character limits per platform (mirrors queue-service/worker.ts's
// PLATFORM_LIMITS on the agent-portal side -- static, small enough to
// duplicate client-side rather than add a new endpoint just to read these numbers).
export const PLATFORM_CHAR_LIMIT: Record<string, number> = {
  linkedin: 3000, instagram: 2200, facebook: 63000, x: 280, twitter: 280,
  youtube: 5000, threads: 500, tiktok: 2200, bluesky: 300,
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
        <div className="w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)' }}>
          <h2 style={{ fontSize: 'var(--text-lg)', color: 'var(--text)' }}>Archive first</h2>
          <p style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>
            <strong>{agentName}</strong> needs to be archived before it can be deleted. Archive and delete it now?
          </p>
          <div className="flex gap-3 pt-2">
            <button onClick={onClose} disabled={loading} className="flex-1 px-4 py-2 border" style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>
              Cancel
            </button>
            <button onClick={onArchiveThenDelete} disabled={loading} className="flex-1 px-4 py-2 text-white hover:opacity-90 disabled:opacity-50" style={{ background: 'var(--danger)', borderRadius: 'var(--radius-sm)' }}>
              {loading ? 'Working…' : 'Archive & delete'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)' }}>
        <h2 style={{ fontSize: 'var(--text-lg)', color: 'var(--text)' }}>Delete Agent</h2>
        <p style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>
          Are you sure you want to delete <strong>{agentName}</strong>? This action cannot be undone.
        </p>
        <div className="flex gap-3 pt-2">
          <button onClick={onClose} disabled={loading} className="flex-1 px-4 py-2 border" style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>
            Cancel
          </button>
          <button onClick={onConfirm} disabled={loading} className="flex-1 px-4 py-2 text-white disabled:opacity-50" style={{ background: 'var(--danger)', borderRadius: 'var(--radius-sm)' }}>
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
