import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useEffect, useState, lazy, Suspense, type ReactNode } from "react";
import { useApplyTheme } from "@/lib/theme";
import { OrganizationProvider } from "./contexts/OrganizationContext";
import { SubscriptionProvider } from "./contexts/SubscriptionContext";
import { UsageProvider } from "./contexts/UsageContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import RouteLoadingFallback from "./components/RouteLoadingFallback";
import BrandLoader from "./components/BrandLoader";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import Auth from "./pages/Auth";
// The editor is the heaviest route and never the first paint of a cold visit;
// it loads as its own chunk behind a dark shell skeleton.
const Editor = lazy(() => import("./pages/Editor"));
import { DashboardLayout } from "./pages/Dashboard";
// Route-level code-splitting: these previously all imported eagerly, bundling
// marketing pages, dashboard pages, and rarely-hit utility routes into one
// 1.57MB main chunk regardless of which single route a visitor actually
// loads. Same lazy()+Suspense(fallback=null) pattern already proven in
// production for /admin below -- a visitor to "/" never pays for dashboard
// code, and vice versa. Index/NotFound/Auth/AuthCallback stay eager: Index is
// the very first paint most cold visitors hit, and Auth/AuthCallback are
// needed immediately in the sign-in flow.
/**
 * The dashboard is the only light-capable surface; everything else was built
 * on dark. Force `dark` on <html> off the dashboard so those pages and their
 * portals (dialogs, sheets, popovers render on body) stay as designed.
 */
function ScrollReset() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.history.scrollRestoration = 'manual';
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function ThemeScope({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const onDashboard = pathname === '/dashboard' || pathname.startsWith('/dashboard/');
  useApplyTheme(!onDashboard);
  return <>{children}</>;
}

/** The editor's frame, drawn before its code arrives: sidebar, toolbar, an empty stage. */
function EditorShellFallback() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <div className="hidden lg:flex w-[380px] shrink-0 flex-col border-r border-border bg-card">
        <div className="h-10 border-b border-border px-3 flex items-center"><div className="skeleton h-3 w-28" /></div>
        <div className="flex-1 p-4 space-y-3"><div className="skeleton h-3 w-32" /><div className="skeleton h-3 w-56" /></div>
        <div className="p-2.5"><div className="skeleton h-[92px] w-full" /></div>
      </div>
      <div className="flex flex-1 flex-col">
        <div className="h-10 border-b border-border px-3 flex items-center gap-2">
          <div className="skeleton h-5 w-16" /><div className="skeleton h-5 w-5" /><div className="skeleton h-5 w-5" /><div className="skeleton ml-auto h-6 w-20" />
        </div>
        <div className="flex-1 flex items-center justify-center p-1">
          <div className="h-full w-full bg-card ring-1 ring-border flex items-center justify-center">
            <BrandLoader variant="orbit" size={120} label="Loading editor" />
          </div>
        </div>
      </div>
    </div>
  );
}

const ProjectSettings = lazy(() => import("./pages/ProjectSettings"));
const SeoManager = lazy(() => import("./pages/SeoManager"));
const BatchValidate = lazy(() => import("./pages/BatchValidate"));
const DashboardHome = lazy(() => import("./pages/dashboard/Home"));
const WorkspaceSettings = lazy(() => import("./pages/dashboard/WorkspaceSettings"));
const DashboardProjects = lazy(() => import("./pages/dashboard/Projects"));
const DashboardDesigns = lazy(() => import("./pages/dashboard/Designs"));
const EcgAgentsPage = lazy(() => import("./pages/dashboard/EcgAgents"));
const EcgCloudPage = lazy(() => import("./pages/dashboard/EcgCloud"));
const DashboardSettings = lazy(() => import("./pages/dashboard/Settings"));
const AdminLogin = lazy(() => import("./pages/admin/Login"));
const AdminApp = lazy(() => import("./pages/admin/AdminApp"));
const AcceptInvite = lazy(() => import("./pages/AcceptInvite"));
const AcceptProjectInvite = lazy(() => import("./pages/AcceptProjectInvite"));
const Privacy = lazy(() => import("./pages/Privacy"));
const Terms = lazy(() => import("./pages/Terms"));
const PublicLayout = lazy(() => import("./components/public-site/PublicLayout"));
const Features = lazy(() => import("./pages/marketing/Features"));
const Pricing = lazy(() => import("./pages/marketing/Pricing"));
const About = lazy(() => import("./pages/marketing/About"));
const Contact = lazy(() => import("./pages/marketing/Contact"));
const Docs = lazy(() => import("./pages/marketing/Docs"));
const Blog = lazy(() => import("./pages/marketing/Blog"));
const Changelog = lazy(() => import("./pages/marketing/Changelog"));
import AuthCallback from "./pages/AuthCallback";
import { supabase } from "./integrations/supabase/client";
import './i18n/config';

// Default cache window for settings/dashboard data   most of it doesn't
// change from other clients mid-session, so re-fetching on every remount
// (e.g. re-opening a settings tab) was just wasted API calls.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 min   data is "fresh enough", no refetch
      gcTime: 15 * 60 * 1000,   // keep cached data around for 15 min unused
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function RequireAuth({ children }: { children: JSX.Element }) {
  const [status, setStatus] = useState<'loading' | 'authenticated' | 'unauthenticated'>('loading');
  const location = useLocation();

  useEffect(() => {
    let alive = true;

    const verifyAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        if (alive) setStatus('unauthenticated');
        return;
      }
      if (alive) setStatus('authenticated');
    };

    verifyAuth();

    return () => {
      alive = false;
    };
  }, []);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <BrandLoader variant="compass" size={100} label="Verifying session" />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    const redirect = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/auth?redirect=${encodeURIComponent(redirect)}`} replace />;
  }

  return children;
}

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <OrganizationProvider>
          <SubscriptionProvider>
            <UsageProvider>
              <Toaster />
              <Sonner />
              <BrowserRouter
                future={{
                  v7_startTransition: true,
                  v7_relativeSplatPath: true,
                }}
              >
                <ThemeScope>
                <ScrollReset />
                <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/auth" element={<Auth />} />
                <Route path="/auth/callback" element={<AuthCallback />} />
                <Route path="/project/:projectId" element={<RequireAuth><Suspense fallback={<EditorShellFallback />}><Editor /></Suspense></RequireAuth>} />
                <Route path="/editor/:projectId" element={<RequireAuth><Suspense fallback={<EditorShellFallback />}><Editor /></Suspense></RequireAuth>} />
                <Route path="/project/:projectId/settings" element={<RequireAuth><Suspense fallback={<RouteLoadingFallback />}><ProjectSettings /></Suspense></RequireAuth>} />
                <Route path="/project/:projectId/seo" element={<RequireAuth><Suspense fallback={<RouteLoadingFallback />}><SeoManager /></Suspense></RequireAuth>} />
                <Route path="/dashboard" element={<RequireAuth><DashboardLayout /></RequireAuth>}>
                  <Route index element={<Suspense fallback={<RouteLoadingFallback />}><DashboardHome /></Suspense>} />
                  <Route path="organizations" element={<Suspense fallback={<RouteLoadingFallback />}><WorkspaceSettings /></Suspense>} />
                  <Route path="projects" element={<Suspense fallback={<RouteLoadingFallback />}><DashboardProjects /></Suspense>} />
                  <Route path="designs" element={<Suspense fallback={<RouteLoadingFallback />}><DashboardDesigns /></Suspense>} />
                  <Route path="ecg-agents" element={<Suspense fallback={<RouteLoadingFallback />}><EcgAgentsPage /></Suspense>} />
                  <Route path="cloud" element={<Suspense fallback={<RouteLoadingFallback />}><EcgCloudPage /></Suspense>} />
                  <Route path="profile" element={<Navigate to="/dashboard/settings" replace />} />
                  <Route path="team" element={<Navigate to="/dashboard/organizations" replace />} />
                  <Route path="settings" element={<Suspense fallback={<RouteLoadingFallback />}><DashboardSettings /></Suspense>} />
                </Route>
                <Route path="/admin/login" element={<Suspense fallback={<RouteLoadingFallback />}><AdminLogin /></Suspense>} />
                {/* AdminApp mounts once with sidebar layout; handles auth + all /admin/* sub-routes */}
                <Route path="/admin/*" element={<Suspense fallback={<RouteLoadingFallback />}><AdminApp /></Suspense>} />
                <Route path="/batch-validate" element={<Suspense fallback={<RouteLoadingFallback />}><BatchValidate /></Suspense>} />
                <Route path="/invite/:token" element={<Suspense fallback={<RouteLoadingFallback />}><AcceptInvite /></Suspense>} />
                <Route path="/project-invite/:token" element={<Suspense fallback={<RouteLoadingFallback />}><AcceptProjectInvite /></Suspense>} />
                <Route path="/privacy" element={<Suspense fallback={<RouteLoadingFallback />}><Privacy /></Suspense>} />
                <Route path="/terms" element={<Suspense fallback={<RouteLoadingFallback />}><Terms /></Suspense>} />
                <Route element={<Suspense fallback={<RouteLoadingFallback />}><PublicLayout /></Suspense>}>
                  <Route path="/features" element={<Suspense fallback={<RouteLoadingFallback />}><Features /></Suspense>} />
                  <Route path="/pricing" element={<Suspense fallback={<RouteLoadingFallback />}><Pricing /></Suspense>} />
                  <Route path="/about" element={<Suspense fallback={<RouteLoadingFallback />}><About /></Suspense>} />
                  <Route path="/contact" element={<Suspense fallback={<RouteLoadingFallback />}><Contact /></Suspense>} />
                  <Route path="/docs" element={<Suspense fallback={<RouteLoadingFallback />}><Docs /></Suspense>} />
                  <Route path="/blog" element={<Suspense fallback={<RouteLoadingFallback />}><Blog /></Suspense>} />
                  <Route path="/changelog" element={<Suspense fallback={<RouteLoadingFallback />}><Changelog /></Suspense>} />
                </Route>
                {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                <Route path="*" element={<NotFound />} />
              </Routes>
                </ThemeScope>
            </BrowserRouter>
          </UsageProvider>
        </SubscriptionProvider>
      </OrganizationProvider>
    </TooltipProvider>
  </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
