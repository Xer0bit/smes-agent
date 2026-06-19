import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AddonCard } from './AddonCard';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useAddonAccess } from '@/hooks/useAddonAccess';

interface AliCloudMigrationProps {
  orgId: string;
  currentTier?: string | null;
}

type MigrationStatus = 'idle' | 'pending' | 'migrating' | 'completed' | 'failed';

const ALI_REGIONS = [
  { value: 'cn-hangzhou', label: 'China (Hangzhou)' },
  { value: 'cn-shanghai', label: 'China (Shanghai)' },
  { value: 'cn-beijing', label: 'China (Beijing)' },
  { value: 'cn-shenzhen', label: 'China (Shenzhen)' },
  { value: 'ap-southeast-1', label: 'Singapore' },
];

const STATUS_COLORS: Record<MigrationStatus, string> = {
  idle: 'secondary',
  pending: 'secondary',
  migrating: 'default',
  completed: 'default',
  failed: 'destructive',
} as const;

export function AliCloudMigration({ orgId, currentTier }: AliCloudMigrationProps) {
  const { hasAccess, loading: accessLoading } = useAddonAccess(orgId, 'ali_cloud');
  const [region, setRegion] = useState('cn-hangzhou');
  const [bucketName, setBucketName] = useState('');
  const [status, setStatus] = useState<MigrationStatus>('idle');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!hasAccess) return;
    supabase
      .from('ali_cloud_configs')
      .select('region, bucket_name, migration_status')
      .eq('org_id', orgId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setRegion(data.region ?? 'cn-hangzhou');
          setBucketName(data.bucket_name ?? '');
          setStatus((data.migration_status as MigrationStatus) ?? 'idle');
        }
      });
  }, [orgId, hasAccess]);

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from('ali_cloud_configs').upsert(
      { org_id: orgId, region, bucket_name: bucketName || null },
      { onConflict: 'org_id' }
    );
    setSaving(false);
    if (error) toast.error('Failed to save AliCloud config');
    else toast.success('AliCloud config saved');
  };

  return (
    <AddonCard
      title="AliCloud Migration"
      description="Migrate your project assets and deployments to Alibaba Cloud."
      requiresTier="agency"
      currentTier={currentTier}
      active={hasAccess}
      loading={accessLoading}
    >
      {hasAccess && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Migration status:</span>
            <Badge variant={STATUS_COLORS[status] as 'secondary' | 'default' | 'destructive'}>
              {status}
            </Badge>
          </div>
          <div className="space-y-1">
            <Label>Region</Label>
            <Select value={region} onValueChange={setRegion}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALI_REGIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Bucket Name</Label>
            <Input
              value={bucketName}
              onChange={(e) => setBucketName(e.target.value)}
              placeholder="my-ecomgear-bucket"
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
