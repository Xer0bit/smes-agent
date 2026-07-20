/**
 * /auth/callback
 *
 * OAuth redirect landing page. Supabase processes the access_token from the
 * URL hash during client init (detectSessionInUrl:true), so by the time this
 * component mounts there is usually already a live session. We handle both:
 *
 *  A) getSession() returns session immediately  ← most common (hash already parsed)
 *  B) onAuthStateChange fires SIGNED_IN later   ← fallback for slow networks
 *
 * After confirming a session we:
 *   1. Check if user already has an org membership (returning user)
 *   2. If new user → call signup-complete to create org + first project
 *   3. Navigate to /dashboard
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import type { Session } from "@supabase/supabase-js";

export default function AuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<"loading" | "setting-up" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const handled = useRef(false);

  const processSession = async (session: Session) => {
    if (handled.current) return;
    handled.current = true;

    const user = session.user;

    try {
      // Check if user already has an org (returning user).
      // .limit(1) is required   .maybeSingle() returns null (not data) when
      // multiple rows exist, causing a new org to be created on every login.
      const { data: existingMember } = await supabase
        .from("org_members")
        .select("org_id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();

      if (existingMember) {
        navigate("/dashboard", { replace: true });
        return;
      }

      // Secondary check: user may own an org without an org_members row
      const { data: existingOrg } = await supabase
        .from("organizations")
        .select("id")
        .eq("created_by", user.id)
        .limit(1)
        .maybeSingle();

      if (existingOrg) {
        navigate("/dashboard", { replace: true });
        return;
      }

      // New OAuth user   provision org + project
      setStatus("setting-up");

      const displayName =
        user.user_metadata?.full_name ||
        user.user_metadata?.name ||
        user.email?.split("@")[0] ||
        "My Workspace";

      const anonKey =
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
        import.meta.env.VITE_SUPABASE_ANON_KEY ||
        "";

      try {
        const { error: signupError } = await supabase.functions.invoke(
          "signup-complete",
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
              apikey: anonKey,
            },
            body: {
              user_id: user.id,
              organization_name: `${displayName}'s Workspace`,
              project_name: "My First Project",
            },
          }
        );

        if (!signupError && user.email) {
          supabase.functions.invoke("welcome", {
            body: {
              email: user.email,
              user_name: displayName,
              org_name: `${displayName}'s Workspace`,
            },
          }).catch(() => {}); // fire-and-forget   don't block navigation
        }

        if (signupError) {
          console.warn("signup-complete edge fn failed, trying direct insert:", signupError.message);

          // Guard: re-check before fallback insert   signup-complete may have
          // succeeded partially, or another tab may have already created the org.
          const { data: guardMember } = await supabase
            .from("org_members").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
          const { data: guardOrg } = guardMember ? { data: null } : await supabase
            .from("organizations").select("id").eq("created_by", user.id).limit(1).maybeSingle();

          if (guardMember || guardOrg) {
            navigate("/dashboard", { replace: true });
            return;
          }

          const slugBase = `${displayName}-workspace`
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
          const slug = `${slugBase || 'workspace'}-${Math.random().toString(36).slice(2, 8)}`;

          // Fallback: create org directly via DB (current schema)
          const { data: org } = await supabase
            .from("organizations")
            .insert({
              name: `${displayName}'s Workspace`,
              slug,
              created_by: user.id,
            })
            .select("id")
            .single();

          if (org) {
            await supabase.from("org_members").insert({
              org_id: org.id,
              user_id: user.id,
              role: "admin",
            });

            await supabase.from("projects").insert({
              name: "My First Project",
              user_id: user.id,
              created_by: user.id,
              organization_id: org.id,
            });
          }
        }
      } catch (fnErr) {
        console.warn("Workspace setup skipped:", fnErr);
      }

      navigate("/dashboard", { replace: true });
    } catch (err: any) {
      console.error("AuthCallback error:", err);
      setErrorMsg(err.message || "Something went wrong during sign-in.");
      setStatus("error");
    }
  };

  useEffect(() => {
    const urlError = searchParams.get("error");
    const urlErrorDesc = searchParams.get("error_description");

    // ── Path A: session already set (hash parsed before component mounted) ──
    // Always check session first   even when error params are present, a previous
    // session may still be valid (e.g. user was already logged in via email).
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        processSession(session);
        return;
      }

      // ── Path 0: GoTrue returned an error and there is no session ──
      if (urlError) {
        handled.current = true;
        const desc = urlErrorDesc
          ? decodeURIComponent(urlErrorDesc.replace(/\+/g, " "))
          : urlError;
        // Surface friendlier message for token exchange failure
        const friendly = desc.toLowerCase().includes("exchange")
          ? "Google sign-in failed. Please try again or use email/password to log in."
          : desc;
        setErrorMsg(friendly);
        setStatus("error");
      }
    });

    // ── Path B: SIGNED_IN fires while component is mounted ──
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session && !handled.current) {
          processSession(session);
        }
      }
    );

    // Safety timeout
    const timeout = setTimeout(() => {
      if (!handled.current) {
        setErrorMsg(
          "Sign-in timed out. The redirect may not have completed. Please try again."
        );
        setStatus("error");
      }
    }, 10000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
    // processSession is stable (uses refs); navigate is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === "error") {
    const isServerError = errorMsg.toLowerCase().includes("exchange") ||
      errorMsg.toLowerCase().includes("server_error") ||
      errorMsg.toLowerCase().includes("unexpected_failure");

    return (
      <div className="min-h-screen bg-[#101622] flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <p className="text-lg font-semibold text-white mb-2">Sign-in failed</p>
          <p className="text-sm text-slate-400 mb-6">
            {isServerError
              ? "Google sign-in could not be completed. Please try again."
              : errorMsg}
          </p>
          <button
            onClick={() => navigate("/auth")}
            className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors mb-3"
          >
            Try again
          </button>
          <button
            onClick={() => navigate("/")}
            className="text-sm text-slate-500 hover:text-slate-400 transition-colors"
          >
            ← Back to home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#101622] flex items-center justify-center px-6">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-sm text-slate-400">
          {status === "setting-up"
            ? "Setting up your workspace…"
            : "Completing sign-in…"}
        </p>
      </div>
    </div>
  );
}
