import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ChevronDown, ChevronRight, Settings as SettingsIcon, Server, Building2, Search, Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { supabase } from "@/integrations/supabase/client";

interface SettingsSidebarProps {
  activeSection: string;
  onSectionChange: (section: string) => void;
  projectId?: string;
}

interface NavItem {
  id: string;
  label: string;
  featureKey?: string;
  /** Not built yet (or, for Analytics, awaiting external GCP OAuth setup) — greyed out, not clickable. */
  disabled?: boolean;
  badge?: 'new' | 'hot';
  /** Opens a sub-page with more than one setting inside it (e.g. an accordion), not a single form. */
  hub?: boolean;
}

interface NavGroup {
  id: string;
  title: string;
  icon: React.ReactNode;
  items: NavItem[];
}

// Groups are scoped by "whose setting is this" — This Project / Platform / Account —
// not by topic. Within each group, live items come first and disabled ("Soon")
// items sink to the bottom under their own divider (see renderItems), so a user
// scanning the top of a group never lands on a dead end.
function buildGroups(isChinaOrg: boolean): NavGroup[] {
  return [
    {
      id: "project",
      title: "This Project",
      icon: <SettingsIcon className="h-4 w-4" />,
      items: [
        { id: "project-settings", label: "Project Settings" },
        { id: "project-seo", label: "SEO", badge: 'hot' },
        { id: "project-domains", label: "Domains", featureKey: "hosting" },
        { id: "integrations", label: "Integrations", hub: true },
        { id: "project-collaborators", label: "Collaborators", featureKey: "invite_editors" },
        { id: "project-knowledge", label: "Knowledge", featureKey: "knowledge_base" },
        { id: "project-git", label: "Git" },
        { id: "project-secrets", label: "Secrets" },
      ],
    },
    {
      id: "platform",
      title: "Platform",
      icon: <Server className="h-4 w-4" />,
      items: [
        { id: "ecomgear-database", label: "Database", badge: 'hot' },
        { id: "ecomgear-functions", label: "Edge Functions" },
        { id: "ecomgear-llm", label: "LLM", disabled: true },
        ...(isChinaOrg ? [
          { id: "integrations-china", label: "China Market — Overview" },
          { id: "china-icp", label: ".cn ICP Filing", badge: 'new' as const },
          { id: "china-qq", label: "QQ Auth", disabled: true },
          { id: "china-iamsmart", label: "HK iAM Smart", disabled: true },
        ] : []),
      ],
    },
    {
      id: "account",
      title: "Account",
      icon: <Building2 className="h-4 w-4" />,
      items: [
        { id: "workspace-plans", label: "Plan & Usage" },
        { id: "workspace-referrals", label: "Referrals" },
        { id: "workspace-api-access", label: "API Access", featureKey: "api_access", disabled: true },
        { id: "workspace-white-label", label: "White-label", featureKey: "remove_branding", disabled: true },
        { id: "workspace-autopilot", label: "Autopilot", featureKey: "auto_pilot", disabled: true },
      ],
    },
  ];
}

export const SettingsSidebar = ({ activeSection, onSectionChange, projectId }: SettingsSidebarProps) => {
  const { hasFeature } = useSubscription();
  const [query, setQuery] = useState("");
  const [isChinaOrg, setIsChinaOrg] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    project: true,
    platform: true,
    account: true,
  });

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      const { data: project } = await supabase
        .from("projects")
        .select("organization_id")
        .eq("id", projectId)
        .maybeSingle();
      if (!project?.organization_id || cancelled) return;
      const { data: org } = await supabase
        .from("organizations")
        .select("region")
        .eq("id", project.organization_id)
        .maybeSingle();
      if (!cancelled) setIsChinaOrg(org?.region === "cn");
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const GROUPS = useMemo(() => buildGroups(isChinaOrg), [isChinaOrg]);

  const toggleSection = (sectionId: string) => {
    setExpandedSections(prev => ({ ...prev, [sectionId]: !prev[sectionId] }));
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) return GROUPS;
    return GROUPS
      .map(group => ({ ...group, items: group.items.filter(item => item.label.toLowerCase().includes(normalizedQuery)) }))
      .filter(group => group.items.length > 0);
  }, [normalizedQuery, GROUPS]);

  const renderItem = (item: NavItem) => {
    const locked = !!item.featureKey && !item.disabled && !hasFeature(item.featureKey);
    const isActive = activeSection === item.id;
    return (
      <button
        key={item.id}
        disabled={item.disabled}
        onClick={() => { if (!item.disabled) onSectionChange(item.id); }}
        className={cn(
          "relative w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] transition-colors duration-smooth text-left",
          item.disabled
            ? "text-white/15 cursor-not-allowed"
            : isActive
              ? "text-white font-medium"
              : "text-white/30 hover:bg-white/[0.04] hover:text-white/60"
        )}
      >
        {isActive && !item.disabled && (
          <motion.span
            layoutId="settings-nav-active"
            className="absolute inset-0 rounded-md bg-indigo-500/10 border-l-2 border-indigo-500/60"
            transition={{ duration: 0.2 }}
          />
        )}
        <span className="relative z-[1] flex-1 truncate">{item.label}</span>
        {item.badge === 'new' && (
          <span className="relative z-[1] px-1.5 py-0.5 text-[10px] font-semibold bg-secondary/20 text-secondary rounded leading-none">NEW</span>
        )}
        {item.badge === 'hot' && (
          <span className="relative z-[1] px-1.5 py-0.5 text-[10px] font-bold bg-orange-500/20 text-orange-400 rounded leading-none">HOT</span>
        )}
        {locked && (
          <Lock className="relative z-[1] h-3 w-3 shrink-0 text-white/25" />
        )}
        {item.hub && !item.disabled && (
          <ChevronRight className="relative z-[1] h-3 w-3 shrink-0 text-white/25" />
        )}
        {item.disabled && (
          <span className="relative z-[1] px-1.5 py-0.5 text-[10px] font-medium bg-white/[0.06] text-white/25 rounded leading-none">Soon</span>
        )}
      </button>
    );
  };

  return (
    <div className="w-56 border-r border-white/[0.07] bg-workspace-surface flex flex-col flex-shrink-0">
      <div className="p-2 pb-1">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/25" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings"
            className="w-full rounded-md border border-white/[0.07] bg-workspace-surface-recessed py-1.5 pl-8 pr-2 text-[12px] text-white/70 placeholder:text-white/25 outline-none transition-colors duration-smooth focus:border-indigo-500/40"
          />
        </div>
      </div>

      <ScrollArea className="flex-1 py-1 px-2">
        <nav className="space-y-0.5">
          {filteredGroups.map((group) => {
            const live = group.items.filter(i => !i.disabled);
            const soon = group.items.filter(i => i.disabled);
            return (
              <div key={group.id} className="mb-1">
                <button
                  onClick={() => toggleSection(group.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/30 hover:text-white/60 transition-colors duration-smooth"
                >
                  <span className="text-primary">{group.icon}</span>
                  <span className="flex-1 text-left">{group.title}</span>
                  <ChevronDown className={cn("h-3 w-3 transition-transform duration-smooth", (normalizedQuery || expandedSections[group.id]) && "rotate-180")} />
                </button>
                {(!!normalizedQuery || expandedSections[group.id]) && (
                  <div className="mt-1 ml-6 space-y-0.5">
                    {live.map(renderItem)}
                    {soon.length > 0 && (
                      <>
                        <p className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wider text-white/15">Coming soon</p>
                        {soon.map(renderItem)}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {normalizedQuery && filteredGroups.length === 0 && (
            <p className="px-2 py-6 text-center text-[12px] text-white/25">No settings match "{query}"</p>
          )}
        </nav>
      </ScrollArea>
    </div>
  );
};
