import { LayoutTemplate } from 'lucide-react';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';

const PLACEHOLDER_SLOTS = [0, 1, 2, 3, 4, 5];

export default function DashboardDesigns() {
  return (
    <div className="p-6 sm:p-8">
      <DashboardPageHeader
        title="Templates"
        description="Start from a ready-made template instead of a blank prompt."
      />

      <div className="mt-6 rounded-xl border border-dashed border-border/60 bg-card/40 p-10 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <LayoutTemplate className="h-5 w-5 text-primary" />
        </div>
        <p className="mt-4 font-display text-base font-semibold text-foreground">In development</p>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
          A gallery of prebuilt templates is coming here. Pick one and remix it into your
          own project instead of starting from an empty prompt.
        </p>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {PLACEHOLDER_SLOTS.map((i) => (
          <div key={i} className="overflow-hidden rounded-xl border border-border/60 bg-card/40">
            <div className="h-40 animate-pulse bg-card/60" />
            <div className="p-4">
              <div className="h-3.5 w-2/3 animate-pulse rounded bg-card/60" />
              <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-card/60" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
