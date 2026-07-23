import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { supabase, lovableCloud } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useSubscription } from '@/contexts/SubscriptionContext';
import { Card, CardContent } from '@/components/ui/card';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';
import { DESIGN_TEMPLATES, type DesignTemplate, buildTemplatePrompt } from '@/data/designTemplates';
import { TemplateQuestionnaire } from '@/components/TemplateQuestionnaire';
import { toast } from 'sonner';

export default function DashboardDesigns() {
  const navigate = useNavigate();
  const { currentOrganizationId, organizations, setCurrentOrganizationId } = useOrganization();
  const { hasFeature } = useSubscription();
  const canUseTemplates = hasFeature('premium_templates');

  const [creating, setCreating] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<DesignTemplate | null>(null);
  const [questionnaireOpen, setQuestionnaireOpen] = useState(false);

  const handleCreateFromTemplate = async (tpl: DesignTemplate, prompt?: string) => {
    if (!canUseTemplates) {
      toast.error('Design templates are not available on this plan.');
      return;
    }

    if (!prompt) {
      setPendingTemplate(tpl);
      setQuestionnaireOpen(true);
      return;
    }

    try {
      setCreating(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const orgId = currentOrganizationId || organizations[0]?.id || null;
      const projectName = `${tpl.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;

      const { data, error } = await lovableCloud.functions.invoke<{
        success: boolean;
        project: { id: string };
      }>('revision-create-project', {
        body: { name: projectName, user_id: user.id, organization_id: orgId },
      });

      if (error) throw error;
      const newProject = data?.project;
      if (!newProject?.id) throw new Error('Failed to create project');

      if (orgId) setCurrentOrganizationId(orgId);

      navigate(`/project/${newProject.id}`, {
        state: { initialPrompt: prompt, shouldGenerate: true, isGuest: false },
      });
    } catch (error) {
      console.error('Failed to create project from template:', error);
      toast.error('Failed to create project from template');
    } finally {
      setCreating(false);
    }
  };

  const handleQuestionnaireSubmit = (template: DesignTemplate, answers: Record<string, string>) => {
    setQuestionnaireOpen(false);
    const enhancedPrompt = buildTemplatePrompt(template, answers);
    setPendingTemplate(null);
    handleCreateFromTemplate(template, enhancedPrompt);
  };

  return (
    <div className="p-6 sm:p-8">
      <DashboardPageHeader
        title="Designs"
        description="Start a new project from a ready-made template."
      />

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {DESIGN_TEMPLATES.map((tpl, i) => (
          <motion.div
            key={tpl.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
          >
            <Card
              className={`group overflow-hidden rounded-xl border-border/60 shadow-[0_8px_24px_hsl(220_45%_5%/0.16)] transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_18px_44px_hsl(220_45%_5%/0.3)] ${creating ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}
              onClick={() => handleCreateFromTemplate(tpl)}
            >
              <div className="relative aspect-video overflow-hidden bg-muted">
                <div
                  className="absolute inset-0 flex items-center justify-center"
                  style={{ background: tpl.accent, color: tpl.fg }}
                >
                  <span className="font-display text-2xl opacity-60">{tpl.name}</span>
                </div>
                <img
                  src={tpl.image}
                  alt={tpl.name}
                  className="relative z-[1] h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.03]"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </div>
              <CardContent className="p-4">
                <h4 className="truncate font-display text-base font-semibold text-foreground">{tpl.name}</h4>
                <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{tpl.description}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {tpl.tag.split(' · ').map((t) => (
                    <span key={t} className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">{t}</span>
                  ))}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      <TemplateQuestionnaire
        template={pendingTemplate}
        open={questionnaireOpen}
        onOpenChange={setQuestionnaireOpen}
        onSubmit={handleQuestionnaireSubmit}
      />
    </div>
  );
}
