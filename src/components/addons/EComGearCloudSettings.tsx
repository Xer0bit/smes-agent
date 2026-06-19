import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AddonCard } from './AddonCard';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { toast } from 'sonner';
import { useAddonAccess } from '@/hooks/useAddonAccess';

interface EComGearCloudSettingsProps {
  orgId: string;
  currentTier?: string | null;
}

interface CloudConfig {
  storage_used_mb: number;
  storage_limit_mb: number;
  custom_domain: string | null;
  enabled: boolean;
}

export function EComGearCloudSettings({ orgId, currentTier }: EComGearCloudSettingsProps) {
  const { hasAccess, loading: accessLoading } = useAddonAccess(orgId, 'ecomgear_cloud');
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [customDomain, setCustomDomain] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!hasAccess) return;
    supabase
      .from('ecomgear_cloud_configs')
      .select('storage_used_mb, storage_limit_mb, custom_domain, enabled')
      .eq('org_id', orgId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setConfig(data as CloudConfig);
          setCustomDomain(data.custom_domain ?? '');
        }
      });
  }, [orgId, hasAccess]);

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from('ecomgear_cloud_configs').upsert(
      { org_id: orgId, custom_domain: customDomain || null },
      { onConflict: 'org_id' }
    );
    setSaving(false);
    if (error) toast.error('Failed to save cloud settings');
    else toast.success('Cloud settings saved');
  };

  const storagePercent = config
    ? Math.min(100, Math.round((config.storage_used_mb / config.storage_limit_mb) * 100))
    : 0;

  return (
    <AddonCard
      title="eComGear Cloud"
      description="Host your projects on eComGear-managed infrastructure with custom domains."
      requiresTier="pro"
      currentTier={currentTier}
      active={hasAccess}
      loading={accessLoading}
    >
      {hasAccess && config && (
        <div className="space-y-3 pt-2">
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Storage</span>
              <span>
                {config.storage_used_mb} / {config.storage_limit_mb} MB
              </span>
            </div>
            <Progress value={storagePercent} className="h-2" />
          </div>
          <div className="space-y-1">
            <Label>Custom Domain</Label>
            <div className="flex gap-2">
              <Input
                value={customDomain}
                onChange={(e) => setCustomDomain(e.target.value)}
                placeholder="store.yourdomain.com"
              />
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AddonCard>
  );
}
