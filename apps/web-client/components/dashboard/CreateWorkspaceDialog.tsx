import { useState } from 'react';
import { z } from 'zod';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { TIER_LIMITS } from '@/services/subscriptionService';
import { useOrganization } from '@/contexts/OrganizationContext';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const createOrgSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100, 'Name must be less than 100 characters'),
  slug: z.string().trim().min(2).max(50).regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens'),
  region: z.enum(['global', 'cn']),
});

function generateSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpgradeRequired: () => void;
}

export function CreateWorkspaceDialog({ open, onOpenChange, onUpgradeRequired }: CreateWorkspaceDialogProps) {
  const { refreshOrganization } = useOrganization();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [region, setRegion] = useState<'global' | 'cn'>('global');
  const [creating, setCreating] = useState(false);

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slug || slug === generateSlug(name)) setSlug(generateSlug(value));
  };

  const reset = () => { setName(''); setSlug(''); setRegion('global'); };

  const handleCreate = async () => {
    try {
      const validated = createOrgSchema.parse({ name, slug, region });
      setCreating(true);

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: ownedOrgs } = await supabase
        .from('organizations')
        .select('id, plan_tier')
        .eq('created_by', user.id);
      const hasPaidOrg = (ownedOrgs || []).some(o => o.plan_tier !== 'free');
      const userMaxOrgs = hasPaidOrg ? TIER_LIMITS.pro.max_orgs : TIER_LIMITS.free.max_orgs;
      if ((ownedOrgs?.length ?? 0) >= userMaxOrgs) {
        toast.error('Free accounts are limited to 1 organization. Upgrade to create more.');
        onOpenChange(false);
        onUpgradeRequired();
        return;
      }

      const { data: existing } = await supabase.from('organizations').select('id').eq('slug', validated.slug).maybeSingle();
      if (existing) { toast.error('This slug is already taken'); return; }

      const { data: newOrg, error } = await supabase
        .from('organizations')
        .insert({ name: validated.name, slug: validated.slug, region: validated.region, plan_tier: 'free', status: 'active', created_by: user.id })
        .select()
        .single();
      if (error) throw error;

      toast.success('Workspace created');
      // Re-fetch the accessible-workspaces list (not just set the id) --
      // OrganizationContext derives currentOrganization by looking up
      // currentOrganizationId inside its cached `organizations` array. The
      // brand-new workspace isn't in that cache yet, so a bare
      // setCurrentOrganizationId(newOrg.id) resolved to no match at all --
      // every workspace showed as inactive until a full page reload
      // re-fetched the list fresh. refreshOrganization() does both the
      // refetch and the activation in one step, same as what reload did.
      await refreshOrganization(user, newOrg.id);
      onOpenChange(false);
      reset();
    } catch (error) {
      if (error instanceof z.ZodError) toast.error(error.errors[0].message);
      else { console.error('Failed to create workspace:', error); toast.error('Failed to create workspace'); }
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-w-md rounded-xl">
        <DialogHeader>
          <DialogTitle className="font-display">Create workspace</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="new-org-name">Name</Label>
            <Input id="new-org-name" value={name} onChange={e => handleNameChange(e.target.value)} placeholder="Acme Inc." className="rounded-lg" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-org-slug">Slug</Label>
            <Input id="new-org-slug" value={slug} onChange={e => setSlug(e.target.value)} placeholder="acme-inc" className="rounded-lg" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-org-region">Region</Label>
            <Select value={region} onValueChange={(v) => setRegion(v as 'global' | 'cn')}>
              <SelectTrigger id="new-org-region"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global</SelectItem>
                <SelectItem value="cn">China</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="rounded-full" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="rounded-full" onClick={handleCreate} disabled={creating}>{creating ? 'Creating…' : 'Create workspace'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
