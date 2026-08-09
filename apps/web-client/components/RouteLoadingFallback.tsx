import { Loader2 } from "lucide-react";

// Suspense fallback for lazy-loaded routes. Fires while the route's JS chunk
// downloads, before we know what page is coming -- so unlike a data-shaped
// skeleton (see dashboard/Home.tsx) this stays generic. Mirrors the visual
// language of Dashboard.tsx's "Preparing your workspace" auth-check state.
export default function RouteLoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-5 py-4">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <p className="text-sm font-medium text-foreground">Loading…</p>
      </div>
    </div>
  );
}
