import { useState, useEffect, useRef } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";
import { useOrganization } from "@/contexts/OrganizationContext";
import { LandingContext } from "@/contexts/LandingContext";
import { LoginDialog } from "@/components/LoginDialog";
import SiteHeader from "./SiteHeader";
import SiteFooter from "./SiteFooter";
import "@/styles/public-site.css";

export default function PublicLayout() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const { refreshOrganization } = useOrganization();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) refreshOrganization(session.user);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) refreshOrganization(session.user);
    });
    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const targets = el.querySelectorAll(".smes-site-reveal");
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, []);

  const onLaunch = () => {
    if (user) navigate("/dashboard");
    else navigate("/");
  };

  return (
    <LandingContext.Provider value={{ user, onLoginClick: () => setIsLoginOpen(true), onLaunch }}>
      <div className="smes-site-root" ref={containerRef}>
        <SiteHeader />
        <Outlet />
        <SiteFooter />
      </div>
      <LoginDialog open={isLoginOpen} onOpenChange={setIsLoginOpen} />
    </LandingContext.Provider>
  );
}
