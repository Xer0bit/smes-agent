/**
 * Admin: the one price list behind every workspace's plan.
 * Edits apply to every org on the next estimate; nothing is billed here.
 */
import { useEffect, useState } from 'react';
import { Panel, btn, input } from '@/components/admin/ui';
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

  const field = (label: string, control: React.ReactNode) => (
    <label className="block space-y-1">
      <span className="text-[11px] text-gray-500">{label}</span>
      {control}
    </label>
  );

  return (
    <Panel title={`Price list · ${draft.name}`} actions={<button className={btn.primary} disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>}>
      <div className="p-3 space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {MONEY.map(([key, label]) => field(`${label} $/mo`,
            <input type="number" min={0} step={1} value={draft[key] / 100} className={input}
              onChange={(e) => setDraft({ ...draft, [key]: Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100)) })} />,
          ))}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {COUNTS.map(([key, label]) => field(`Included ${label}`,
            <input type="number" min={0} step={1} value={draft[key]} className={input}
              onChange={(e) => setDraft({ ...draft, [key]: Math.max(0, parseInt(e.target.value, 10) || 0) })} />,
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-2">
          {field('Includes (comma separated)',
            <input value={draft.includes.join(', ')} className={input}
              onChange={(e) => setDraft({ ...draft, includes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />,
          )}
          {field('Over fair use',
            <select value={draft.overage_policy} onChange={(e) => setDraft({ ...draft, overage_policy: e.target.value === 'allow' ? 'allow' : 'stop' })} className={input + ' bg-[#0b0c10]'}>
              <option value="stop">Stop the agent</option>
              <option value="allow">Allow and record</option>
            </select>,
          )}
        </div>
      </div>
    </Panel>
  );
}
