/**
 * Admin: the one price list behind every workspace's plan.
 * Edits apply to every org on the next estimate; nothing is billed here.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { fetchCatalog, updateCatalog, type Catalog } from '@/services/planService';

type Money = 'base_price_cents' | 'app_price_cents' | 'user_price_cents' | 'agent_price_cents' | 'database_price_cents';
type Count = 'included_apps' | 'included_users' | 'included_agents' | 'included_databases' | 'included_eco_per_app';

const MONEY: Array<[Money, string]> = [
  ['base_price_cents', 'Base'], ['app_price_cents', 'App'], ['user_price_cents', 'User'], ['agent_price_cents', 'Agent'], ['database_price_cents', 'Database'],
];
const COUNTS: Array<[Count, string]> = [
  ['included_apps', 'Apps'], ['included_users', 'Users'], ['included_agents', 'Agents'], ['included_databases', 'Databases'], ['included_eco_per_app', 'Eco / app / month'],
];

export function PlanCatalogCard() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [draft, setDraft] = useState<Catalog | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchCatalog().then(({ catalog }) => { setCatalog(catalog); setDraft(catalog); }).catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not load the price list'));
  }, []);

  if (!draft || !catalog) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(catalog);

  const save = async () => {
    setSaving(true);
    try {
      const { id: _id, currency: _c, ...patch } = draft;
      const { catalog: next } = await updateCatalog(patch);
      setCatalog(next); setDraft(next);
      toast.success('Price list updated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the price list');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="bg-white/[0.03] border-white/10">
      <CardHeader className="pb-3">
        <CardTitle className="text-white text-base">Price list · {draft.name}</CardTitle>
        <p className="text-xs text-gray-400">Base plan plus per-unit price. Included quantities come free with the base.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {MONEY.map(([key, label]) => (
            <div key={key} className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider text-gray-500">{label} $/mo</Label>
              <Input type="number" min={0} step={1} value={draft[key] / 100}
                onChange={(e) => setDraft({ ...draft, [key]: Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100)) })}
                className="h-9 bg-white/5 border-white/10 text-white" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {COUNTS.map(([key, label]) => (
            <div key={key} className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider text-gray-500">Included {label}</Label>
              <Input type="number" min={0} step={1} value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                className="h-9 bg-white/5 border-white/10 text-white" />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1 flex-1">
            <Label className="text-[10px] uppercase tracking-wider text-gray-500">Includes (comma separated)</Label>
            <Input value={draft.includes.join(', ')}
              onChange={(e) => setDraft({ ...draft, includes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              className="h-9 bg-white/5 border-white/10 text-white" />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-gray-500">Over fair use</Label>
            <select value={draft.overage_policy} onChange={(e) => setDraft({ ...draft, overage_policy: e.target.value === 'allow' ? 'allow' : 'stop' })}
              className="h-9 rounded-md bg-white/5 border border-white/10 text-white text-sm px-2">
              <option value="stop">Stop the agent</option>
              <option value="allow">Allow and record</option>
            </select>
          </div>
          <div className="pt-4">
            <Button size="sm" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving' : 'Save price list'}</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
