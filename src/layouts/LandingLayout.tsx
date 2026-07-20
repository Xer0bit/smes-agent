
import { Header } from "@/components/landing/Header";
import { Footer } from "@/components/landing/Footer";
import { LoginDialog } from "@/components/LoginDialog";
import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";
import { useOrganization } from "@/contexts/OrganizationContext";
import { LandingContext } from "@/contexts/LandingContext";
import "@/styles/landing.css";

export const LandingLayout = () => {
    const [isLoginOpen, setIsLoginOpen] = useState(false);
    const [user, setUser] = useState<User | null>(null);
    const { refreshOrganization } = useOrganization();

    useEffect(() => {
        // Single auth subscription for the entire landing site
        supabase.auth.getSession().then(({ data: { session } }) => {
            setUser(session?.user ?? null);
            if (session?.user) refreshOrganization(session.user);
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setUser(session?.user ?? null);
            if (session?.user) refreshOrganization(session.user);
        });

        return () => subscription.unsubscribe();
    // refreshOrganization is intentionally omitted   it is a stable async function
    // that doesn't change identity, and including it would re-subscribe on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <LandingContext.Provider value={{ user, onLoginClick: () => setIsLoginOpen(true) }}>
            <div className="ecg-landing min-h-screen flex flex-col">
                <Header onLoginClick={() => setIsLoginOpen(true)} user={user} />
                <main className="flex-1">
                    <Outlet />
                </main>
                <Footer />
                <LoginDialog open={isLoginOpen} onOpenChange={setIsLoginOpen} />
            </div>
        </LandingContext.Provider>
    );
};
