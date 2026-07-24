const MAP: Record<string, string> = {
  active: 'bg-green-100 text-green-700', approved: 'bg-green-100 text-green-700',
  succeeded: 'bg-green-100 text-green-700', posted: 'bg-green-100 text-green-700',
  pending: 'bg-amber-100 text-amber-700', provisioning: 'bg-amber-100 text-amber-700',
  scheduled: 'bg-blue-100 text-blue-700', posting: 'bg-blue-100 text-blue-700',
  draft: 'bg-slate-100 text-slate-600', idle: 'bg-slate-100 text-slate-600',
  cancelled: 'bg-slate-100 text-slate-500',
  suspended: 'bg-red-100 text-red-700', rejected: 'bg-red-100 text-red-700', failed: 'bg-red-100 text-red-700',
};

// Plain-language labels for the raw backend post status vocabulary --
// "draft" reads as unfinished/broken to a non-technical user; it actually
// means "the agent wrote this, it's waiting for you."
const LABELS: Record<string, string> = {
  draft: 'Needs review',
  scheduled: 'Scheduled',
  posting: 'Publishing…',
  posted: 'Published',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export default function StatusBadge({ status }: { status: string }) {
  const key = status?.toLowerCase();
  const cls = MAP[key] ?? 'bg-slate-100 text-slate-600';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${cls}`}>
      {LABELS[key] ?? status}
    </span>
  );
}
