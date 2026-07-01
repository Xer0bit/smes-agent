const MAP: Record<string, string> = {
  active: 'bg-green-100 text-green-700', approved: 'bg-green-100 text-green-700',
  succeeded: 'bg-green-100 text-green-700', pending: 'bg-amber-100 text-amber-700',
  provisioning: 'bg-amber-100 text-amber-700', draft: 'bg-slate-100 text-slate-600',
  idle: 'bg-slate-100 text-slate-600', suspended: 'bg-red-100 text-red-700',
  rejected: 'bg-red-100 text-red-700', failed: 'bg-red-100 text-red-700',
};
export default function StatusBadge({ status }: { status: string }) {
  const cls = MAP[status?.toLowerCase()] ?? 'bg-slate-100 text-slate-600';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}
