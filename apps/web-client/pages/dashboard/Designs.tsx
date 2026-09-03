/**
 * Dashboard → Templates: the community gallery.
 *
 * Every card is a project its owner shared. Preview opens the live site,
 * Remix creates a new project in the active workspace seeded with the
 * template's files and opens it in the editor. Owners share from
 * Project Settings → Community template.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ExternalLink, GitFork, LayoutTemplate, Loader2, Sparkles, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';
import { ProjectThumbnail } from '@/components/dashboard/ProjectThumbnail';
import { useOrganization } from '@/contexts/OrganizationContext';
import { fetchTemplates, remixTemplate, fetchBlueprints, startBlueprint, TEMPLATE_CATEGORIES, type CommunityTemplate, type Blueprint } from '@/services/templateService';
import { stashPendingPrompt } from '@/services/pendingPromptHandoff';
import { cn } from '@/lib/utils';
import { BlueprintPreview } from '@/components/templates/BlueprintPreview';

// Literal so Tailwind's scanner generates them; the API's accent is only a fallback hint.
const ACCENTS: Record<string, string> = {
  'admin-dashboard': 'from-slate-800 via-slate-700 to-teal-600',
  'erp-suite': 'from-zinc-900 via-blue-900 to-indigo-600',
  crm: 'from-fuchsia-900 via-purple-800 to-violet-600',
  'saas-landing': 'from-sky-900 via-cyan-700 to-emerald-500',
  'creative-agency': 'from-orange-700 via-rose-600 to-pink-500',
  'three-d-showcase': 'from-indigo-950 via-blue-800 to-cyan-400',
  'math-textbook': 'from-stone-900 via-amber-900 to-yellow-600',
  'learning-platform': 'from-emerald-900 via-green-700 to-lime-500',
  'research-hub': 'from-slate-900 via-cyan-900 to-teal-500',
  storefront: 'from-neutral-900 via-red-900 to-orange-500',
  booking: 'from-teal-900 via-emerald-800 to-cyan-500',
  portfolio: 'from-neutral-900 via-neutral-700 to-neutral-400',
  'docs-site': 'from-gray-900 via-violet-900 to-purple-500',
};

export default function DashboardDesigns() {
  const navigate = useNavigate();
  const { currentOrganizationId } = useOrganization();
  const [templates, setTemplates] = useState<CommunityTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string>('');
  const [remixing, setRemixing] = useState<string | null>(null);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [starting, setStarting] = useState<string | null>(null);

  const load = useCallback(async () => {
    fetchBlueprints().then((r) => setBlueprints(r.blueprints)).catch(() => setBlueprints([]));
    try {
      const { templates } = await fetchTemplates();
      setTemplates(templates);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load templates');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    if (!templates) return [];
    const needle = q.trim().toLowerCase();
    return templates.filter((t) =>
      (!category || t.template_category === category) &&
      (!needle || t.name.toLowerCase().includes(needle) || (t.description ?? '').toLowerCase().includes(needle) || t.template_tags.some((tag) => tag.toLowerCase().includes(needle))),
    );
  }, [templates, q, category]);

  const categories = useMemo(() => {
    const present = new Set<string>();
    for (const b of blueprints) present.add(b.category);
    for (const t of templates ?? []) if (t.template_category) present.add(t.template_category);
    const ordered = [...TEMPLATE_CATEGORIES].filter((c) => present.has(c));
    for (const c of present) if (!ordered.includes(c as typeof TEMPLATE_CATEGORIES[number])) ordered.push(c as typeof TEMPLATE_CATEGORIES[number]);
    return ordered;
  }, [templates, blueprints]);

  const visibleBlueprints = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return blueprints.filter((b) =>
      (!category || b.category === category) &&
      (!needle || b.name.toLowerCase().includes(needle) || b.tagline.toLowerCase().includes(needle) || b.category.toLowerCase().includes(needle) || b.stack.some((s) => s.toLowerCase().includes(needle))),
    );
  }, [blueprints, q, category]);

  const start = async (b: Blueprint) => {
    setStarting(b.id);
    try {
      const { project, starter_prompt } = await startBlueprint(b.id, { organization_id: currentOrganizationId ?? null });
      toast.success(`Started "${project.name}". The agent has the blueprint rules.`);
      // Plan first: the agent lays out the architecture and design for approval, then builds.
      stashPendingPrompt(project.id, { initialPrompt: starter_prompt, mode: 'plan' });
      navigate(`/project/${project.id}`, { state: { initialPrompt: starter_prompt, shouldGenerate: true, mode: 'plan' } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start from this blueprint');
    } finally {
      setStarting(null);
    }
  };

  const remix = async (t: CommunityTemplate) => {
    setRemixing(t.id);
    try {
      const { project } = await remixTemplate(t.id, { organization_id: currentOrganizationId ?? null });
      toast.success(`Created "${project.name}" from ${t.name}`);
      navigate(`/project/${project.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remix this template');
    } finally {
      setRemixing(null);
    }
  };

  return (
    <div className="p-6 sm:p-8">
      <DashboardPageHeader
        title="Templates"
        description="Community-built apps ready to remix. Start from one, then make it yours with the agent."
      />

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search templates…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-10 rounded-full" />
        </div>
        {categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setCategory('')} className={cn('rounded-full border px-3 py-1 text-xs transition-colors', !category ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border/60 text-muted-foreground hover:text-foreground')}>All</button>
            {categories.map((c) => (
              <button key={c} type="button" onClick={() => setCategory(c === category ? '' : c)} className={cn('rounded-full border px-3 py-1 text-xs transition-colors', category === c ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border/60 text-muted-foreground hover:text-foreground')}>{c}</button>
            ))}
          </div>
        )}
      </div>

      {visibleBlueprints.length > 0 && (
        <section className="mt-6">
          <div className="mb-3 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold inline-flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" />Start from a blueprint</h2>
              <p className="text-sm text-muted-foreground">Curated build guides. The agent gets the stack, page map and design rules; you get a first prompt to send.</p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visibleBlueprints.map((b) => (
              <article key={b.id} className="group flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card transition-colors hover:border-border">
                <div className={cn('relative aspect-[16/9] bg-gradient-to-br overflow-hidden', ACCENTS[b.id] ?? 'from-slate-800 via-slate-700 to-slate-500')}>
                  <BlueprintPreview id={b.id} />
                  <span className="absolute left-3 top-3 rounded-full bg-black/35 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/90 backdrop-blur-sm">{b.category}</span>
                </div>
                <div className="flex flex-1 flex-col p-4">
                  <h3 className="text-base font-semibold">{b.name}</h3>
                  <p className="text-sm text-muted-foreground">{b.tagline}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {b.stack.slice(0, 4).map((s) => <span key={s} className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">{s}</span>)}
                    {b.stack.length > 4 && <span className="px-1 text-[10px] text-muted-foreground">+{b.stack.length - 4}</span>}
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                    <span className="text-[11px] text-muted-foreground">{b.pages.length} pages</span>
                    <Button size="sm" className="rounded-full h-8" disabled={starting === b.id} onClick={() => start(b)}>
                      {starting === b.id ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}Start<ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {error && <p className="mt-6 text-sm text-destructive">{error}</p>}

      {templates && (visible.length > 0 || templates.length > 0) && (
        <h2 className="mt-10 mb-3 text-base font-semibold inline-flex items-center gap-2"><GitFork className="h-4 w-4 text-primary" />Community remixes</h2>
      )}

      {!templates && !error && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-64 rounded-xl" />)}
        </div>
      )}

      {templates && visible.length === 0 && visibleBlueprints.length === 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-border/60 bg-card/40 p-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <LayoutTemplate className="h-5 w-5 text-primary" />
          </div>
          <p className="mt-4 text-base font-semibold text-foreground">{templates.length === 0 ? 'No templates shared yet' : 'Nothing matches'}</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            {templates.length === 0
              ? 'Share one of your projects from Project Settings → Community template and it appears here for everyone to remix.'
              : 'Try another search or category.'}
          </p>
        </div>
      )}

      {templates && visible.length > 0 && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((t) => (
            <article key={t.id} className="group flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card transition-colors hover:border-border">
              <div className="relative h-44">
                <ProjectThumbnail projectName={t.name} thumbnailUrl={t.thumbnail_url} previewUrl={t.preview_url} />
                {t.template_category && <Badge variant="secondary" className="absolute left-3 top-3 rounded-full text-[10px]">{t.template_category}</Badge>}
              </div>
              <div className="flex flex-1 flex-col p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold truncate">{t.name}</h3>
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground shrink-0"><GitFork className="h-3 w-3" />{t.remix_count}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground line-clamp-2 min-h-[2rem]">{t.description || 'No description yet.'}</p>
                {t.template_tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.template_tags.slice(0, 4).map((tag) => <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{tag}</span>)}
                  </div>
                )}
                <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                  <span className="text-[11px] text-muted-foreground truncate">{t.author ? `by ${t.author}` : ''}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {t.preview_url && (
                      <Button asChild variant="outline" size="sm" className="rounded-full h-8">
                        <a href={t.preview_url} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5 mr-1" />Preview</a>
                      </Button>
                    )}
                    <Button size="sm" className="rounded-full h-8" disabled={remixing === t.id} onClick={() => remix(t)}>
                      {remixing === t.id ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <GitFork className="h-3.5 w-3.5 mr-1" />}Remix
                    </Button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
