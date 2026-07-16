import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { SettingsSidebar } from "./SettingsSidebar";
import { SettingsContent } from "./SettingsContent";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSection?: string;
  projectId?: string;
  workspaceFiles?: { path: string; content: string }[];
}

export const SettingsDialog = ({
  open,
  onOpenChange,
  defaultSection = "project-settings",
  projectId,
  workspaceFiles = [],
}: SettingsDialogProps) => {
  const [activeSection, setActiveSection] = useState(defaultSection);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) setActiveSection(defaultSection);
  }, [open, defaultSection]);

  // SEO lives on its own dedicated page (route detection + per-page editor) —
  // SettingsContent has no in-dialog case for it, so route there directly
  // instead of falling through to the "coming soon" placeholder.
  const handleSectionChange = (next: string) => {
    if (next === "project-seo" && projectId) {
      onOpenChange(false);
      navigate(`/project/${projectId}/seo`);
      return;
    }
    setActiveSection(next);
  };

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-workspace-surface-recessed animate-page-enter">
      {/* Top bar */}
      <div className="h-10 flex items-center justify-between px-5 border-b border-white/[0.07] bg-workspace-surface flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-semibold text-white/90 tracking-tight">Settings</span>
          <div className="h-3 w-px bg-white/[0.08]" />
          <span className="text-[11px] text-white/35 capitalize">
            {activeSection.replace(/-/g, ' ')}
          </span>
        </div>
        <button
          onClick={() => onOpenChange(false)}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-white/60 hover:text-white/90 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.07] text-[11px] font-medium transition-colors duration-smooth"
          title="Back to project (Esc)"
        >
          <ArrowLeft className="h-3 w-3" />
          <span>Back</span>
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <SettingsSidebar activeSection={activeSection} onSectionChange={handleSectionChange} />
        <div className="flex-1 min-w-0 h-full overflow-hidden">
          <SettingsContent activeSection={activeSection} projectId={projectId} workspaceFiles={workspaceFiles} />
        </div>
      </div>
    </div>
  );
};
