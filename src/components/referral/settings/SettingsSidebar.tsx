import { useState } from "react";
import { ChevronRight, Settings as SettingsIcon, Globe, BookOpen, Building2, CreditCard, Cloud, Wrench, TestTube, Boxes, ChevronDown, Database, Search, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
interface SettingsSidebarProps {
  activeSection: string;
  onSectionChange: (section: string) => void;
}

interface NavItem {
  id: string;
  label: string;
  featureKey?: string;
}

export const SettingsSidebar = ({ activeSection, onSectionChange }: SettingsSidebarProps) => {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    project: true,
    workspace: true,
    integrations: true,
    connectors: true,
    ecomgear: true,
    chinaEco: true,
    database: false,
    llm: false,
  });

  const toggleSection = (sectionId: string) => {
    setExpandedSections(prev => ({ ...prev, [sectionId]: !prev[sectionId] }));
  };

  const projectItems: NavItem[] = [
    { id: "project-settings", label: "Project Settings" },
    { id: "project-seo", label: "SEO" },
    { id: "project-integrations", label: "Header Integrations" },
    { id: "project-collaborators", label: "Collaborators", featureKey: "invite_editors" },
    { id: "project-domains", label: "Domains", featureKey: "hosting" },
    { id: "project-knowledge", label: "Knowledge", featureKey: "knowledge_base" },
    { id: "project-secrets", label: "Secrets" },
  ];

  const workspaceItems: NavItem[] = [
    { id: "workspace-plans", label: "Plan & Usage" },
    { id: "workspace-analytics", label: "Analytics", featureKey: "analytics" },
    { id: "workspace-api-access", label: "API Access", featureKey: "api_access" },
    { id: "workspace-white-label", label: "White-label", featureKey: "remove_branding" },
    { id: "workspace-autopilot", label: "Autopilot", featureKey: "auto_pilot" },
    { id: "workspace-referrals", label: "Referrals" },
  ];

  const integrationItems: NavItem[] = [
    { id: "integrations-stripe", label: "Stripe", featureKey: "integrations" },
    { id: "integrations-alipay", label: "Alipay", featureKey: "integrations" },
    { id: "integrations-airwallex", label: "Airwallex", featureKey: "integrations" },
  ];

  const connectorItems: NavItem[] = [
    { id: "connector-github", label: "GitHub" },
  ];

  const chinaEcoItems: NavItem[] = [
    { id: "integrations-china", label: "Overview" },
    { id: "china-icp", label: ".cn ICP Filing" },
    { id: "china-qq", label: "QQ Auth" },
    { id: "china-iamsmart", label: "HK iAM Smart" },
  ];

  const renderSection = (title: string, items: NavItem[], sectionId: string, icon: React.ReactNode) => (
    <div className="mb-1">
      <button
        onClick={() => toggleSection(sectionId)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/30 hover:text-white/60 transition-colors"
      >
        {icon}
        <span className="flex-1 text-left">{title}</span>
      </button>
      {expandedSections[sectionId] && (
        <div className="mt-1 ml-6 space-y-0.5">
          {items.map((item) => {

            return (
              <button
                key={item.id}
                onClick={() => {
                  onSectionChange(item.id);
                }}
                className={cn(
                  "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] transition-colors text-left",
                  activeSection === item.id
                    ? "bg-indigo-500/10 text-white font-medium border-l-2 border-indigo-500/60"
                    : "text-white/40 hover:bg-white/[0.04] hover:text-white/70"
                )}
              >
                {item.id === "china-icp" && (
                  <span className="px-1.5 py-0.5 text-xs font-semibold bg-secondary/20 text-secondary rounded">
                    NEW
                  </span>
                )}
                <span className="flex-1">{item.label}</span>
                {item.id === "project-seo" && (
                  <span className="px-1.5 py-0.5 text-[10px] font-bold bg-green-500/20 text-green-400 rounded leading-none">HOT</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderNestedSection = () => (
    <div className="mb-1">
      <button
        onClick={() => toggleSection('ecomgear')}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/30 hover:text-white/60 transition-colors"
      >
        <Cloud className="h-4 w-4 text-primary" />
        <span className="flex-1 text-left">eComGear Cloud</span>
      </button>
      {expandedSections['ecomgear'] && (
        <div className="mt-1 ml-6 space-y-1">
          {/* Database Section */}
          <button
            onClick={() => onSectionChange('ecomgear-database')}
            className={cn(
              "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] transition-colors text-left",
              activeSection === 'ecomgear-database'
                ? "bg-indigo-500/10 text-white font-medium border-l-2 border-indigo-500/60"
                : "text-white/40 hover:bg-white/[0.04] hover:text-white/70"
            )}
          >
            <Database className="h-4 w-4" />
            <span className="flex-1">Database</span>
            <span className="px-1.5 py-0.5 text-[10px] font-bold bg-orange-500/20 text-orange-400 rounded leading-none">HOT</span>
          </button>

          {/* LLM Section */}
          <button
            onClick={() => onSectionChange('ecomgear-llm')}
            className={cn(
              "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] transition-colors text-left",
              activeSection === 'ecomgear-llm'
                ? "bg-indigo-500/10 text-white font-medium border-l-2 border-indigo-500/60"
                : "text-white/40 hover:bg-white/[0.04] hover:text-white/70"
            )}
          >
            <Boxes className="h-4 w-4" />
            <span className="flex-1">LLM</span>
          </button>

          {/* China Ecosystem Section */}
          <button
            onClick={() => toggleSection('chinaEco')}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/30 hover:text-white/60 transition-colors"
          >
            <Globe className="h-4 w-4" />
            <span className="flex-1 text-left">China Ecosystem</span>
            <ChevronDown className={cn(
              "h-3 w-3 transition-transform",
              expandedSections['chinaEco'] && "rotate-180"
            )} />
          </button>
          {expandedSections['chinaEco'] && (
            <div className="ml-6 space-y-0.5">
              {chinaEcoItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => onSectionChange(item.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] transition-colors text-left",
                    activeSection === item.id
                      ? "bg-indigo-500/10 text-white font-medium border-l-2 border-indigo-500/60"
                      : "text-white/40 hover:bg-white/[0.04] hover:text-white/70"
                  )}
                >
                  {item.id === "china-icp" && (
                    <span className="px-1.5 py-0.5 text-xs font-semibold bg-secondary/20 text-secondary rounded">
                      NEW
                    </span>
                  )}
                  <span className="flex-1">{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="w-52 border-r border-white/[0.06] bg-[#0b0b0d] flex flex-col flex-shrink-0">
      <ScrollArea className="flex-1 py-2 px-2">
        <nav className="space-y-0.5">
          {renderSection("Project", projectItems, "project", <SettingsIcon className="h-4 w-4" />)}
          {renderSection("Workspace", workspaceItems, "workspace", <Building2 className="h-4 w-4" />)}
          {renderSection("Integrations", integrationItems, "integrations", <CreditCard className="h-4 w-4" />)}
          {renderSection("Connectors", connectorItems, "connectors", <GitBranch className="h-4 w-4" />)}
          {renderNestedSection()}
        </nav>
      </ScrollArea>
    </div>
  );
};
