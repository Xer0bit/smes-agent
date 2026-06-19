import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AddonCard } from './AddonCard';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useAddonAccess } from '@/hooks/useAddonAccess';

interface AutoPilotConfigProps {
  orgId: string;
  currentTier?: string | null;
}

export function AutoPilotConfig({ orgId, currentTier }: AutoPilotConfigProps) {
  const { hasAccess, loading: accessLoading } = useAddonAccess(orgId, 'auto_pilot');
  const [schedule, setSchedule] = useState<'daily' | 'weekly'>('weekly');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  useEffect(() => {
    if (!hasAccess) return;
    supabase
      .from('auto_pilot_configs')
      .select('schedule, prompt')
      .eq('org_id', orgId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setSchedule(data.schedule as 'daily' | 'weekly');
          setPrompt(data.prompt ?? '');
        }
        setConfigLoaded(true);
      });
  }, [orgId, hasAccess]);

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from('auto_pilot_configs').upsert(
      { org_id: orgId, schedule, prompt },
      { onConflict: 'org_id' }
    );
    setSaving(false);
    if (error) toast.error('Failed to save AutoPilot config');
    else toast.success('AutoPilot config saved');
  };

  return (
    <AddonCard
      title="AutoPilot"
      description="Automatically generate and publish content on a schedule."
      requiresTier="agency"
      currentTier={currentTier}
      active={hasAccess}
      loading={accessLoading}
    >
      {hasAccess && configLoaded && (
        <div className="space-y-3 pt-2">
          <div className="space-y-1">
            <Label>Schedule</Label>
            <Select value={schedule} onValueChange={(v) => setSchedule(v as 'daily' | 'weekly')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Generation Prompt</Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what kind of content to generate…"
              rows={3}
            />
          </div>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save Config'}
          </Button>
        </div>
      )}
    </AddonCard>
  );
}
