import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { SettingsSidebar } from "@/components/referral/settings/SettingsSidebar";
import { SettingsContent } from "@/components/referral/settings/SettingsContent";
export default function ProjectSettings() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const section = searchParams.get("section") || "project-settings";
  const [projectName, setProjectName] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    supabase
      .from("projects")
      .select("name")
      .eq("id", projectId)
      .single()
      .then(({ data }) => { if (data) setProjectName(data.name); });
  }, [projectId]);

  const handleSectionChange = useCallback(
    (next: string) => {
      // SEO now lives entirely on its own dedicated page (route detection +
      // per-page editor)   no in-place section to render here anymore.
      if (next === "project-seo") {
        if (projectId) navigate(`/project/${projectId}/seo`);
        return;
      }
      const p = new URLSearchParams(searchParams);
      p.set("section", next);
      setSearchParams(p, { replace: true });
    },
    [searchParams, setSearchParams, projectId, navigate]
  );

  const handleBack = () => navigate(`/project/${projectId}`);

  return (
    <div className="flex flex-col h-screen bg-black overflow-hidden">
      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleBack}
          className="gap-1.5 text-muted-foreground hover:text-foreground -ml-1"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to editor
        </Button>

        <div className="w-px h-4 bg-border" />

        <div className="flex items-center gap-2 min-w-0">
          {projectName === null
            ? <span className="h-4 w-32 bg-muted animate-pulse rounded inline-block" />
            : <span className="text-sm font-medium text-foreground truncate">{projectName}</span>
          }
          <span className="text-muted-foreground text-sm">/</span>
          <span className="text-sm text-muted-foreground">Settings</span>
        </div>
      </header>

      {/* ── Body: sidebar + content ─────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <SettingsSidebar
          activeSection={section}
          onSectionChange={handleSectionChange}
        />
        <SettingsContent
          activeSection={section}
          projectId={projectId}
          workspaceFiles={[]}
        />
      </div>
    </div>
  );
}
