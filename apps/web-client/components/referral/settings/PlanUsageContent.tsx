/**
 * Settings → Plan: the unit-based subscription.
 *
 *   Base SINGLE  1 App · 1 Agent · OneNET · OneMAIL   $19/mo
 *   + Additional Apps / Users / Agents / Databases     $19 each per month
 *
 * The owner sees what is in use against what is bought, adjusts the
 * quantities with steppers, and the estimate updates live. Saving writes
 * `org_entitlements`; the routes that create each unit refuse past it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Minus, Plus, Check } from "lucide-react";
import { toast } from "sonner";
import {
  fetchPlan, updatePlan, formatDollars, includedQuantity, unitPriceCents,
  UNITS, UNIT_LABELS, type PlanSnapshot, type Unit,
} from "@/services/planService";

function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="skeleton h-24 rounded-xl" />
      <div className="skeleton h-64 rounded-xl" />
    </div>
  );
}

function Stepper({ value, min, onChange, disabled }: { value: number; min: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-background">
      <button
        type="button"
        aria-label="Remove one"
        disabled={disabled || value <= min}
        onClick={() => onChange(value - 1)}
        className="h-8 w-8 grid place-items-center text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="w-8 text-center text-sm tabular-nums">{value}</span>
      <button
        type="button"
        aria-label="Add one"
        disabled={disabled}
        onClick={() => onChange(value + 1)}
        className="h-8 w-8 grid place-items-center text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function PlanUsageContent({ organizationId }: { organizationId?: string } = {}) {
  const { currentOrganizationId: activeOrganizationId } = useOrganization();
  const currentOrganizationId = organizationId ?? activeOrganizationId;
  const [plan, setPlan] = useState<PlanSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<Unit, number> | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrganizationId) return;
    try {
      const snapshot = await fetchPlan(currentOrganizationId);
      setPlan(snapshot);
      setDraft({ apps: snapshot.entitlements.apps, users: snapshot.entitlements.users, agents: snapshot.entitlements.agents, databases: snapshot.entitlements.databases });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the plan");
    }
  }, [currentOrganizationId]);

  useEffect(() => { void load(); }, [load]);

  const estimate = useMemo(() => {
    if (!plan || !draft) return null;
    const { catalog } = plan;
    const lines = UNITS.map((unit) => {
      const extra = Math.max(0, draft[unit] - includedQuantity(catalog, unit));
      return { unit, extra, price: unitPriceCents(catalog, unit), amount: extra * unitPriceCents(catalog, unit) };
    });
    const total = catalog.base_price_cents + lines.reduce((n, l) => n + l.amount, 0);
    return { lines, total };
  }, [plan, draft]);

  const dirty = useMemo(() => {
    if (!plan || !draft) return false;
    return UNITS.some((u) => draft[u] !== plan.entitlements[u]);
  }, [plan, draft]);

  const save = async () => {
    if (!currentOrganizationId || !draft) return;
    setSaving(true);
    try {
      const snapshot = await updatePlan(currentOrganizationId, draft);
      setPlan(snapshot);
      toast.success(`Plan updated: ${formatDollars(snapshot.estimate.total_cents)}/mo`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the plan");
    } finally {
      setSaving(false);
    }
  };

  if (!currentOrganizationId) {
    return <p className="text-sm text-muted-foreground">Open a workspace to see its plan.</p>;
  }
  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!plan || !draft || !estimate) return <Skeleton />;

  const { catalog, usage, over } = plan;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-lg">{catalog.name}</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Includes {catalog.included_apps} App · {catalog.included_agents} Agent · {catalog.includes.join(" · ")}
              </p>
            </div>
            <div className="text-right">
              <div className="text-2xl font-semibold tabular-nums">{formatDollars(catalog.base_price_cents)}</div>
              <div className="text-xs text-muted-foreground">per month</div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">
            Fair use: {catalog.included_eco_per_app} eco of agent work per app per month.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Estimate Monthly Cost</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {UNITS.map((unit) => {
            const included = includedQuantity(catalog, unit);
            const line = estimate.lines.find((l) => l.unit === unit)!;
            const inUse = usage[unit];
            const isOver = over.some((o) => o.unit === unit);
            return (
              <div key={unit} className="flex items-center justify-between gap-4 py-3 border-b border-border last:border-0">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    Additional {UNIT_LABELS[unit].plural}
                    <span className="ml-2 text-xs text-muted-foreground">× {formatDollars(unitPriceCents(catalog, unit))}/mo</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {included} included · {inUse} in use
                    {isOver && <Badge variant="destructive" className="ml-2 h-4 px-1.5 text-[10px]">over plan</Badge>}
                  </div>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <Stepper
                    value={draft[unit]}
                    min={Math.max(included, inUse)}
                    disabled={saving}
                    onChange={(v) => setDraft({ ...draft, [unit]: v })}
                  />
                  <span className="w-16 text-right text-sm tabular-nums">{line.extra > 0 ? formatDollars(line.amount) : "—"}</span>
                </div>
              </div>
            );
          })}

          <div className="pt-4 space-y-1 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Base {catalog.name}</span><span className="tabular-nums">{formatDollars(catalog.base_price_cents)}</span>
            </div>
            {estimate.lines.filter((l) => l.extra > 0).map((l) => (
              <div key={l.unit} className="flex justify-between text-muted-foreground">
                <span>{l.extra} {l.extra === 1 ? UNIT_LABELS[l.unit].singular : UNIT_LABELS[l.unit].plural}</span>
                <span className="tabular-nums">{formatDollars(l.amount)}</span>
              </div>
            ))}
            <div className="flex justify-between font-semibold text-base pt-2 border-t border-border">
              <span>Monthly total</span><span className="tabular-nums">{formatDollars(estimate.total)}/mo</span>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-4">
            {dirty && (
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDraft({ apps: plan.entitlements.apps, users: plan.entitlements.users, agents: plan.entitlements.agents, databases: plan.entitlements.databases })}>
                Reset
              </Button>
            )}
            <Button size="sm" disabled={!dirty || saving} onClick={save}>
              {saving ? "Saving" : dirty ? "Update plan" : (<><Check className="h-3.5 w-3.5 mr-1" /> Up to date</>)}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default PlanUsageContent;
