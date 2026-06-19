import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';

interface ClientMarkupSettingsProps {
  orgId: string;
  clientUserId: string;
  clientName: string;
}

export function ClientMarkupSettings({ orgId, clientUserId, clientName }: ClientMarkupSettingsProps) {
  const [markupType, setMarkupType] = useState<'fixed' | 'percentage'>('percentage');
  const [markupValue, setMarkupValue] = useState('0');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase
      .from('client_markups')
      .select('markup_type, markup_value')
      .eq('org_id', orgId)
      .eq('client_user_id', clientUserId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setMarkupType(data.markup_type as 'fixed' | 'percentage');
          setMarkupValue(String(data.markup_value));
        }
        setLoading(false);
      });
  }, [orgId, clientUserId]);

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from('client_markups').upsert(
      {
        org_id: orgId,
        client_user_id: clientUserId,
        markup_type: markupType,
        markup_value: parseFloat(markupValue) || 0,
      },
      { onConflict: 'org_id,client_user_id' }
    );
    setSaving(false);
    if (error) {
      toast.error('Failed to save markup settings');
    } else {
      toast.success('Markup saved');
    }
  };

  if (loading) return <div className="animate-pulse h-24 bg-muted rounded" />;

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Markup for {clientName}</p>
      <div className="flex items-end gap-3">
        <div className="space-y-1">
          <Label>Type</Label>
          <Select value={markupType} onValueChange={(v) => setMarkupType(v as 'fixed' | 'percentage')}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="percentage">Percentage (%)</SelectItem>
              <SelectItem value="fixed">Fixed ($)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 flex-1">
          <Label>Value</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={markupValue}
            onChange={(e) => setMarkupValue(e.target.value)}
          />
        </div>
        <Button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
