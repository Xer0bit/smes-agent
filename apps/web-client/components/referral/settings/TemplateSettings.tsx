/**
 * Project Settings → Community template: share this project so anyone can
 * remix it from Dashboard → Templates. Only files are copied on remix,
 * never secrets, the database, or edge function logs.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { GitFork } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fetchTemplateSettings, updateTemplateSettings, TEMPLATE_CATEGORIES, type TemplateSettings as Settings } from '@/services/templateService';

export function TemplateSettings({ projectId }: { projectId: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchTemplateSettings(projectId)
      .then((s) => { setSettings(s); setTags(s.template_tags.join(', ')); })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not load template settings'));
  }, [projectId]);

  const save = async (patch: Parameters<typeof updateTemplateSettings>[1]) => {
    setSaving(true);
    try {
      const next = await updateTemplateSettings(projectId, patch);
      setSettings(next);
      if (patch.is_template !== undefined) toast.success(next.is_template ? 'Shared to the community gallery' : 'Removed from the gallery');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white/85 mb-1">Community template</h2>
        <p className="text-sm text-white/45">Let anyone start from this project. A remix copies the files into their workspace, nothing else.</p>
      </div>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="text-base">Share in Templates</CardTitle>
              <CardDescription>Shows this project in Dashboard → Templates for every signed-in user.</CardDescription>
            </div>
            <Switch checked={settings?.is_template ?? false} disabled={!settings || saving} onCheckedChange={(v) => save({ is_template: v })} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={settings?.template_category ?? ''} disabled={!settings || saving} onValueChange={(v) => save({ template_category: v || null })}>
                <SelectTrigger><SelectValue placeholder="Pick a category" /></SelectTrigger>
                <SelectContent>
                  {TEMPLATE_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Tags</Label>
              <Input
                value={tags}
                disabled={!settings || saving}
                placeholder="shop, stripe, tailwind"
                onChange={(e) => setTags(e.target.value)}
                onBlur={() => save({ template_tags: tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8) })}
              />
            </div>
          </div>
          <p className="text-xs text-white/45">Name, description and the thumbnail from Project Settings are what people see on the card.</p>
          {settings && (
            <p className="inline-flex items-center gap-1.5 text-xs text-white/60"><GitFork className="h-3.5 w-3.5" />Remixed {settings.remix_count} time{settings.remix_count === 1 ? '' : 's'}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
