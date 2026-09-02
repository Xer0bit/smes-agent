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
function ThemeScope({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const onDashboard = pathname === '/dashboard' || pathname.startsWith('/dashboard/');
  useApplyTheme(!onDashboard);
  return <>{children}</>;
}

/** The editor's frame, drawn before its code arrives: sidebar, toolbar, an empty stage. */
function EditorShellFallback() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#09090b]">
      <div className="hidden lg:flex w-[380px] shrink-0 flex-col border-r border-white/[0.06] bg-[#0c0c0e]">
        <div className="h-10 border-b border-white/[0.06] px-3 flex items-center"><div className="skeleton h-3 w-28" /></div>
        <div className="flex-1 p-4 space-y-3"><div className="skeleton h-3 w-32" /><div className="skeleton h-3 w-56" /></div>
        <div className="p-2.5"><div className="skeleton h-[92px] w-full rounded-2xl" /></div>
      </div>
      <div className="flex flex-1 flex-col">
        <div className="h-10 border-b border-white/[0.06] px-3 flex items-center gap-2">
          <div className="skeleton h-5 w-16" /><div className="skeleton h-5 w-5" /><div className="skeleton h-5 w-5" /><div className="skeleton ml-auto h-6 w-20 rounded-full" />
        </div>
        <div className="flex-1 p-1"><div className="h-full w-full rounded-lg bg-[#0c0c0e] ring-1 ring-white/[0.06]" /></div>
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
import { LandingLayout } from "./layouts/LandingLayout";
const Features = lazy(() => import("./pages/landing/Features"));
const Product = lazy(() => import("./pages/landing/Product"));
const China = lazy(() => import("./pages/landing/China"));
const Agents = lazy(() => import("./pages/landing/Agents"));
const Pricing = lazy(() => import("./pages/landing/Pricing"));
const Contact = lazy(() => import("./pages/landing/Contact"));
const PrivacyPolicy = lazy(() => import("./pages/landing/PrivacyPolicy"));
const TermsOfService = lazy(() => import("./pages/landing/TermsOfService"));
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
    return null;
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
                <Routes>
                {/* Index has its own nav/footer from the v2 landing design */}
                <Route path="/" element={<Index />} />
                {/* Other landing routes still use shared Header/Footer */}
                <Route element={<LandingLayout />}>
                  <Route path="/product" element={<Suspense fallback={<RouteLoadingFallback />}><Product /></Suspense>} />
                  <Route path="/china" element={<Suspense fallback={<RouteLoadingFallback />}><China /></Suspense>} />
                  <Route path="/features" element={<Suspense fallback={<RouteLoadingFallback />}><Features /></Suspense>} />
                  <Route path="/agents" element={<Suspense fallback={<RouteLoadingFallback />}><Agents /></Suspense>} />
                  <Route path="/pricing" element={<Suspense fallback={<RouteLoadingFallback />}><Pricing /></Suspense>} />
                  <Route path="/contact" element={<Suspense fallback={<RouteLoadingFallback />}><Contact /></Suspense>} />
                  <Route path="/privacy" element={<Suspense fallback={<RouteLoadingFallback />}><PrivacyPolicy /></Suspense>} />
                  <Route path="/terms" element={<Suspense fallback={<RouteLoadingFallback />}><TermsOfService /></Suspense>} />
                </Route>
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
