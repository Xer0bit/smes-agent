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
import EditorWithWorkspace from "./pages/EditorWithWorkspace";
import ProjectSettings from "./pages/ProjectSettings";
import BatchValidate from "./pages/BatchValidate";
import { DashboardLayout } from "./pages/Dashboard";
import DashboardHome from "./pages/dashboard/Home";
import DashboardOrganizations from "./pages/dashboard/Organizations";
import DashboardProjects from "./pages/dashboard/Projects";
import DashboardProfile from "./pages/dashboard/Profile";
import DashboardSettings from "./pages/dashboard/Settings";
import DashboardTeamAccess from "./pages/dashboard/TeamAccess";
const AdminLogin = lazy(() => import("./pages/admin/Login"));
const AdminApp = lazy(() => import("./pages/admin/AdminApp"));
import AcceptInvite from "./pages/AcceptInvite";
import AcceptProjectInvite from "./pages/AcceptProjectInvite";
import { LandingLayout } from "./layouts/LandingLayout";
import Features from "./pages/landing/Features";
import Product from "./pages/landing/Product";
import China from "./pages/landing/China";
import Agents from "./pages/landing/Agents";
import Pricing from "./pages/landing/Pricing";
import Contact from "./pages/landing/Contact";
import PrivacyPolicy from "./pages/landing/PrivacyPolicy";
import TermsOfService from "./pages/landing/TermsOfService";
import AuthCallback from "./pages/AuthCallback";
import { supabase } from "./integrations/supabase/client";
import './i18n/config';

const queryClient = new QueryClient();

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
                  <Route path="/product" element={<Product />} />
                  <Route path="/china" element={<China />} />
                  <Route path="/features" element={<Features />} />
                  <Route path="/agents" element={<Agents />} />
                  <Route path="/pricing" element={<Pricing />} />
                  <Route path="/contact" element={<Contact />} />
                  <Route path="/privacy" element={<PrivacyPolicy />} />
                  <Route path="/terms" element={<TermsOfService />} />
                </Route>
                <Route path="/auth" element={<Auth />} />
                <Route path="/auth/callback" element={<AuthCallback />} />
                <Route path="/project/:projectId" element={<EditorWithWorkspace />} />
                <Route path="/project/:projectId/settings" element={<RequireAuth><ProjectSettings /></RequireAuth>} />
                <Route path="/dashboard" element={<RequireAuth><DashboardLayout /></RequireAuth>}>
                  <Route index element={<DashboardHome />} />
                  <Route path="organizations" element={<DashboardOrganizations />} />
                  <Route path="projects" element={<DashboardProjects />} />
                  <Route path="profile" element={<DashboardProfile />} />
                  <Route path="team" element={<DashboardTeamAccess />} />
                  <Route path="settings" element={<DashboardSettings />} />
                </Route>
                <Route path="/admin/login" element={<Suspense fallback={null}><AdminLogin /></Suspense>} />
                {/* AdminApp mounts once with sidebar layout; handles auth + all /admin/* sub-routes */}
                <Route path="/admin/*" element={<Suspense fallback={null}><AdminApp /></Suspense>} />
                <Route path="/batch-validate" element={<BatchValidate />} />
                <Route path="/invite/:token" element={<AcceptInvite />} />
                <Route path="/project-invite/:token" element={<AcceptProjectInvite />} />
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
