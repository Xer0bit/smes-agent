import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { lovableCloud, supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";
import { toast } from "sonner";
import { useOrganization } from "@/contexts/OrganizationContext";
import { LandingContext } from "@/contexts/LandingContext";
import { LoginDialog } from "@/components/LoginDialog";
import { LandingPage } from "@/components/landing/LandingPage";
import { canCreateProject, showLimitToast, trackUsage } from "@/services/subscriptionService";
import { useGuestSession } from "@/hooks/useGuestSession";
import { TemplateQuestionnaire } from "@/components/TemplateQuestionnaire";
import { type DesignTemplate, buildTemplatePrompt } from "@/data/designTemplates";

// Key for storing pending prompt when redirecting to login
const PENDING_PROMPT_KEY = 'ecomgear_pending_prompt';
const TEMP_PROJECT_KEY = 'ecomgear_temp_project';

interface PendingPrompt {
  prompt: string;
  fileContext?: string;
  timestamp: number;
}

const Index = () => {
  // Self-contained auth   Index no longer lives inside LandingLayout
  const [user, setUser] = useState<User | null>(null);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const { refreshOrganization } = useOrganization();
  const [isProcessingPendingPrompt, setIsProcessingPendingPrompt] = useState(false);
  const { currentOrganizationId } = useOrganization();
  const navigate = useNavigate();
  const prevUserIdRef = useRef<string | null>(null);
  const { canRequest, requestsRemaining, getFingerprint } = useGuestSession();
  const [pendingTemplate, setPendingTemplate] = useState<DesignTemplate | null>(null);
  const [questionnaireOpen, setQuestionnaireOpen] = useState(false);

  // Auth subscription   mirrors LandingLayout pattern
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

  // Create project helper function
  const createProjectAndNavigate = useCallback(async (
    userId: string,
    prompt: string,
    fileContext?: string
  ) => {
    // Check subscription limits before creating
    const limitCheck = await canCreateProject(currentOrganizationId);
    if (!limitCheck.allowed) {
      showLimitToast(limitCheck.reason!, limitCheck.upgradeNeeded);
      return;
    }

    try {
      // Generate project name
      const now = new Date();
      const timestamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
      const projectName = `project-${timestamp}`;

      // Create project using external edge function (bypasses RLS)
      const { data, error } = await lovableCloud.functions.invoke<{
        success: boolean;
        project: { id: string };
      }>('revision-create-project', {
        body: {
          name: projectName,
          user_id: userId,
          organization_id: currentOrganizationId ?? null,
        },
      });

      let newProject: { id: string } | null = data?.project ?? null;

      if (error || !newProject?.id) {
        // Edge function unavailable or returned non-2xx   fall back to direct insert.
        // This handles auth edge cases, cold-start failures, and permission mismatches.
        console.warn('[Index] Edge function failed, falling back to direct insert:', error?.message);
        const { data: directData, error: directError } = await (await import('@/integrations/supabase/client')).supabase
          .from('projects')
          .insert({
            name: projectName,
            user_id: userId,
            created_by: userId,
            organization_id: currentOrganizationId ?? null,
          })
          .select('id')
          .single();
        if (directError) throw directError;
        newProject = directData;
      }

      if (!newProject || !newProject.id) throw new Error('Failed to create project');

      // Track project creation usage
      trackUsage(userId, 'project_create', { orgId: currentOrganizationId, projectId: newProject.id });

      // Navigate to editor with initial state
      navigate(`/project/${newProject.id}`, {
        state: {
          initialPrompt: prompt,
          fileContext: fileContext,
          shouldGenerate: true,
          isGuest: false
        }
      });
    } catch (error) {
      console.error("Error creating project:", error);
      const extractFunctionErrorMessage = async (err: unknown) => {
        const defaultMessage = (err as any)?.message || (typeof err === 'string' ? err : '');

        try {
          const response = (err as any)?.context;
          if (response && typeof response.text === 'function') {
            const raw = await response.text();
            if (raw) {
              const parsed = JSON.parse(raw) as {
                error?: string;
                message?: string;
                details?: string;
              };
              const parts = [parsed.error || parsed.message, parsed.details].filter(Boolean);
              if (parts.length > 0) {
                return parts.join(' - ');
              }
            }
          }
        } catch {
          // Keep default message when response body is not JSON.
        }

        return defaultMessage;
      };

      const message = await extractFunctionErrorMessage(error);
      const displayMessage = message && message !== 'Edge Function returned a non-2xx status code'
        ? message
        : 'Server error   check your organisation membership or try again.';
      toast.error(`Failed to create project: ${displayMessage}`);
    }
  }, [currentOrganizationId, navigate]);

  // Process pending prompt after login
  const processPendingPrompt = useCallback(async (userId: string) => {
    const pendingData = localStorage.getItem(PENDING_PROMPT_KEY);
    if (!pendingData) return;

    try {
      const pending: PendingPrompt = JSON.parse(pendingData);

      // Check if pending prompt is still valid (within 10 minutes)
      const TEN_MINUTES = 10 * 60 * 1000;
      if (Date.now() - pending.timestamp > TEN_MINUTES) {
        localStorage.removeItem(PENDING_PROMPT_KEY);
        return;
      }

      // Clear pending prompt immediately to prevent double-processing
      localStorage.removeItem(PENDING_PROMPT_KEY);

      setIsProcessingPendingPrompt(true);
      toast.info("Creating your project...");

      await createProjectAndNavigate(userId, pending.prompt, pending.fileContext);
    } catch {
      localStorage.removeItem(PENDING_PROMPT_KEY);
    } finally {
      setIsProcessingPendingPrompt(false);
    }
  }, [createProjectAndNavigate]);

  // Call processPendingPrompt exactly once when user first logs in
  useEffect(() => {
    if (user && user.id !== prevUserIdRef.current) {
      prevUserIdRef.current = user.id;
      processPendingPrompt(user.id);
    }
    if (!user) prevUserIdRef.current = null;
  }, [user, processPendingPrompt]);

  const handleCreateProject = useCallback(async (prompt: string, fileContext?: string) => {
    // If not logged in, allow guest mode (up to 3 requests with Gemini)
    if (!user) {
      if (!canRequest) {
        // Guest has exhausted free requests   must register
        toast.error('You\'ve used all 3 free generations. Please sign up to continue!');
        navigate('/auth', {
          state: {
            message: 'Sign up to unlock unlimited AI generations',
            redirectTo: '/',
          },
        });
        return;
      }

      // Create a guest temp project ID and navigate to editor in guest mode
      const guestProjectId = `guest-${crypto.randomUUID()}`;
      const fingerprint = getFingerprint();

      // Store temp project data for migration after login
      localStorage.setItem(TEMP_PROJECT_KEY, JSON.stringify({
        projectId: guestProjectId,
        prompt,
        fileContext,
        fingerprint,
        timestamp: Date.now(),
      }));

      toast.info(`Guest mode: ${requestsRemaining} free generation${requestsRemaining === 1 ? '' : 's'} remaining`);

      navigate(`/project/${guestProjectId}`, {
        state: {
          initialPrompt: prompt,
          fileContext: fileContext,
          shouldGenerate: true,
          isGuest: true,
          fingerprint,
        },
      });
      return;
    }

    // User is logged in - create project directly
    await createProjectAndNavigate(user.id, prompt, fileContext);
  }, [user, navigate, createProjectAndNavigate, canRequest, requestsRemaining, getFingerprint]);

  const handleLaunch = useCallback(() => {
    if (user) {
      navigate("/dashboard");
    } else {
      setIsLoginOpen(true);
    }
  }, [user, navigate]);

  const handleUseTemplate = useCallback((template: DesignTemplate) => {
    setPendingTemplate(template);
    setQuestionnaireOpen(true);
  }, []);

  const handleQuestionnaireSubmit = useCallback((template: DesignTemplate, answers: Record<string, string>) => {
    setQuestionnaireOpen(false);

    const enhancedPrompt = buildTemplatePrompt(template, answers);

    if (user) {
      handleCreateProject(enhancedPrompt);
    } else {
      localStorage.setItem(PENDING_PROMPT_KEY, JSON.stringify({
        prompt: enhancedPrompt,
        timestamp: Date.now(),
      } satisfies PendingPrompt));
      setIsLoginOpen(true);
    }
    setPendingTemplate(null);
  }, [user, handleCreateProject]);

  return (
    <LandingContext.Provider value={{ user, onLoginClick: () => setIsLoginOpen(true), onUseTemplate: handleUseTemplate }}>
      <LandingPage onLaunch={handleLaunch} />
      <LoginDialog open={isLoginOpen} onOpenChange={setIsLoginOpen} />
      <TemplateQuestionnaire
        template={pendingTemplate}
        open={questionnaireOpen}
        onOpenChange={setQuestionnaireOpen}
        onSubmit={handleQuestionnaireSubmit}
      />
    </LandingContext.Provider>
  );
};

export default Index;
