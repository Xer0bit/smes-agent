import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { SeoSettingsPanel } from "@/components/seo/SeoSettingsPanel";

export default function SeoManager() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [projectName, setProjectName] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    supabase.from("projects").select("name").eq("id", projectId).single()
      .then(({ data }) => { if (data) setProjectName(data.name); });
  }, [projectId]);

  const handleBack = () => navigate(`/project/${projectId}/settings`);

  return (
    <div className="flex flex-col h-screen bg-black overflow-hidden">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <Button variant="ghost" size="sm" onClick={handleBack} className="gap-1.5 text-muted-foreground hover:text-foreground -ml-1">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <div className="w-px h-4 bg-border" />
        <div className="flex items-center gap-2 min-w-0">
          {projectName === null
            ? <span className="h-4 w-32 bg-muted animate-pulse rounded inline-block" />
            : <span className="text-sm font-medium text-foreground truncate">{projectName}</span>}
          <span className="text-muted-foreground text-sm">/</span>
          <span className="text-sm text-muted-foreground">SEO Manager</span>
        </div>
      </header>

      <div className="flex-1 min-h-0">
        <SeoSettingsPanel projectId={projectId} />
      </div>
    </div>
  );
}
