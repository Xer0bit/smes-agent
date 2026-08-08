import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useEffect, useState, lazy, Suspense } from "react";
import { OrganizationProvider } from "./contexts/OrganizationContext";
import { SubscriptionProvider } from "./contexts/SubscriptionContext";
import { UsageProvider } from "./contexts/UsageContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import Auth from "./pages/Auth";
import Editor from "./pages/Editor";
import { DashboardLayout } from "./pages/Dashboard";
// Route-level code-splitting: these previously all imported eagerly, bundling
// marketing pages, dashboard pages, and rarely-hit utility routes into one
// 1.57MB main chunk regardless of which single route a visitor actually
// loads. Same lazy()+Suspense(fallback=null) pattern already proven in
// production for /admin below -- a visitor to "/" never pays for dashboard
// code, and vice versa. Index/NotFound/Auth/AuthCallback stay eager: Index is
// the very first paint most cold visitors hit, and Auth/AuthCallback are
// needed immediately in the sign-in flow.
const ProjectSettings = lazy(() => import("./pages/ProjectSettings"));
const SeoManager = lazy(() => import("./pages/SeoManager"));
const BatchValidate = lazy(() => import("./pages/BatchValidate"));
const DashboardHome = lazy(() => import("./pages/dashboard/Home"));
const WorkspaceSettings = lazy(() => import("./pages/dashboard/WorkspaceSettings"));
const DashboardProjects = lazy(() => import("./pages/dashboard/Projects"));
const DashboardDesigns = lazy(() => import("./pages/dashboard/Designs"));
const EcgAgentsPage = lazy(() => import("./pages/dashboard/EcgAgents"));
const DashboardSettings = lazy(() => import("./pages/dashboard/Settings"));
const AdminLogin = lazy(() => import("./pages/admin/Login"));
const AdminApp = lazy(() => import("./pages/admin/AdminApp"));
const AcceptInvite = lazy(() => import("./pages/AcceptInvite"));
const AcceptProjectInvite = lazy(() => import("./pages/AcceptProjectInvite"));
const Billing = lazy(() => import("./pages/Billing"));
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
                <Routes>
                {/* Index has its own nav/footer from the v2 landing design */}
                <Route path="/" element={<Index />} />
                {/* Other landing routes still use shared Header/Footer */}
                <Route element={<LandingLayout />}>
                  <Route path="/product" element={<Suspense fallback={null}><Product /></Suspense>} />
                  <Route path="/china" element={<Suspense fallback={null}><China /></Suspense>} />
                  <Route path="/features" element={<Suspense fallback={null}><Features /></Suspense>} />
                  <Route path="/agents" element={<Suspense fallback={null}><Agents /></Suspense>} />
                  <Route path="/pricing" element={<Suspense fallback={null}><Pricing /></Suspense>} />
                  <Route path="/contact" element={<Suspense fallback={null}><Contact /></Suspense>} />
                  <Route path="/privacy" element={<Suspense fallback={null}><PrivacyPolicy /></Suspense>} />
                  <Route path="/terms" element={<Suspense fallback={null}><TermsOfService /></Suspense>} />
                </Route>
                <Route path="/auth" element={<Auth />} />
                <Route path="/auth/callback" element={<AuthCallback />} />
                <Route path="/project/:projectId" element={<RequireAuth><Editor /></RequireAuth>} />
                <Route path="/editor/:projectId" element={<RequireAuth><Editor /></RequireAuth>} />
                <Route path="/billing" element={<RequireAuth><Suspense fallback={null}><Billing /></Suspense></RequireAuth>} />
                <Route path="/project/:projectId/settings" element={<RequireAuth><Suspense fallback={null}><ProjectSettings /></Suspense></RequireAuth>} />
                <Route path="/project/:projectId/seo" element={<RequireAuth><Suspense fallback={null}><SeoManager /></Suspense></RequireAuth>} />
                <Route path="/dashboard" element={<RequireAuth><DashboardLayout /></RequireAuth>}>
                  <Route index element={<Suspense fallback={null}><DashboardHome /></Suspense>} />
                  <Route path="organizations" element={<Suspense fallback={null}><WorkspaceSettings /></Suspense>} />
                  <Route path="projects" element={<Suspense fallback={null}><DashboardProjects /></Suspense>} />
                  <Route path="designs" element={<Suspense fallback={null}><DashboardDesigns /></Suspense>} />
                  <Route path="ecg-agents" element={<Suspense fallback={null}><EcgAgentsPage /></Suspense>} />
                  <Route path="profile" element={<Navigate to="/dashboard/settings" replace />} />
                  <Route path="team" element={<Navigate to="/dashboard/organizations" replace />} />
                  <Route path="settings" element={<Suspense fallback={null}><DashboardSettings /></Suspense>} />
                </Route>
                <Route path="/admin/login" element={<Suspense fallback={null}><AdminLogin /></Suspense>} />
                {/* AdminApp mounts once with sidebar layout; handles auth + all /admin/* sub-routes */}
                <Route path="/admin/*" element={<Suspense fallback={null}><AdminApp /></Suspense>} />
                <Route path="/batch-validate" element={<Suspense fallback={null}><BatchValidate /></Suspense>} />
                <Route path="/invite/:token" element={<Suspense fallback={null}><AcceptInvite /></Suspense>} />
                <Route path="/project-invite/:token" element={<Suspense fallback={null}><AcceptProjectInvite /></Suspense>} />
                {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </BrowserRouter>
          </UsageProvider>
        </SubscriptionProvider>
      </OrganizationProvider>
    </TooltipProvider>
  </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
