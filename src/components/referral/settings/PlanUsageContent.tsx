import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useUsage } from "@/contexts/UsageContext";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useNavigate } from "react-router-dom";
import {
  Loader2,
  Zap,
  Send,
  Crown,
  ArrowUpRight,
  Globe,
  Code2,
  Users,
  FolderKanban,
  BarChart3,
  Sparkles,
  ShieldCheck,
  RefreshCw,
  CheckCircle2,
  X,
} from "lucide-react";
import { getUsageColor, getProgressColor } from "@/hooks/useUsage";
import { TIER_LIMITS, TIER_LABELS, TIER_FEATURES } from "@/services/subscriptionService";
import { SettingsSkeleton } from "./SettingsSkeleton";

const PLAN_CARDS = [
  {
    id: "free",
    price: "$0",
    priceNote: "forever",
    highlights: ["1 seat", "1 project", "10 eco / month"],
  },
  {
    id: "starter",
    price: "$9.99",
    priceNote: "/ month",
    highlights: ["3 seats", "5 projects", "100 eco / month", "Custom domains", "Code export"],
  },
  {
    id: "professional",
    price: "$49",
    priceNote: "/ month",
    popular: true,
    highlights: ["10 seats", "Unlimited projects", "100 eco / month", "Analytics & API", "Remove branding"],
  },
  {
    id: "enterprise",
    price: "Custom",
    priceNote: "contact us",
    highlights: ["Unlimited seats", "Unlimited projects", "100 eco / month", "SSO & SLA", "Priority support"],
  },
] as const;

const FEATURE_ROWS: { key: string; label: string; icon: React.ElementType }[] = [
  { key: "custom_domains", label: "Custom domains", icon: Globe },
  { key: "export_code", label: "Code export", icon: Code2 },
  { key: "remove_branding", label: "Remove branding", icon: Sparkles },
  { key: "analytics", label: "Analytics dashboard", icon: BarChart3 },
  { key: "api_access", label: "API access", icon: Zap },
  { key: "priority_support", label: "Priority support", icon: ShieldCheck },
];

export const PlanUsageContent = () => {
  const { usageRecord, loading: usageLoading, refreshUsage, getUsagePercentage, getUsageLimit } = useUsage();
  const { limits, loading: subLoading, tier, tierLabel, subscribed, refresh, publishLinesPercent, hasFeature } = useSubscription();
  const { currentOrganizationId } = useOrganization();
  const navigate = useNavigate();

  const loading = usageLoading || subLoading;

  if (loading) {
    return <SettingsSkeleton cards={3} />;
  }

  const ecoLimit = getUsageLimit();
  const ecoPercent = getUsagePercentage();
  const resetAt = usageRecord?.ai_gens_reset_at;

  const fmtDate = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const fmtNum = (n: number) => new Intl.NumberFormat("en-US").format(n);

  const handleManageBilling = () => navigate("/dashboard/organizations");

  return (
    <div className="space-y-8">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Plan & Usage</h2>
          <p className="text-sm text-white/45">
            Your current plan, credits, and resource usage at a glance.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => { refreshUsage(); refresh(); }}
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* ── Current Plan Banner ─────────────────────────────────────────── */}
      <Card className={subscribed ? "border-primary/40 bg-primary/5" : "border-white/[0.07]"}>
        <CardContent className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-5">
          <div className="flex items-center gap-3">
            <div className={`flex items-center justify-center h-10 w-10 rounded-xl ${subscribed ? "bg-primary/20" : "bg-white/[0.04]"}`}>
              <Crown className={`h-5 w-5 ${subscribed ? "text-primary" : "text-white/45"}`} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold">{tierLabel} Plan</span>
                <Badge variant={subscribed ? "default" : "secondary"} className="text-xs">
                  {subscribed ? "Active" : "Free"}
                </Badge>
              </div>
              <p className="text-xs text-white/45">
                {subscribed ? "Billed monthly via Stripe" : "Upgrade to unlock more capacity"}
              </p>
            </div>
          </div>
          <Button size="sm" variant={subscribed ? "outline" : "default"} onClick={handleManageBilling}>
            {subscribed ? "Manage Billing" : "Upgrade Plan"}
            <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        </CardContent>
      </Card>

      {/* ── Usage Meters ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Eco Usage */}
        <Card className="bg-workspace-surface border-white/[0.07]">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Zap className="h-4 w-4 text-yellow-500" />
              Eco
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className={`text-2xl font-bold tabular-nums ${getUsageColor(ecoPercent)}`}>
                {fmtNum(usageRecord?.ai_gens_used ?? 0)}
              </span>
              <span className="text-sm text-white/45">
                / {ecoLimit < 0 ? "∞" : fmtNum(ecoLimit)} per month
              </span>
            </div>
            {ecoLimit > 0 && (
              <Progress value={ecoPercent} className={`h-2 ${getProgressColor(ecoPercent)}`} />
            )}
            <div className="flex items-center justify-between text-xs text-white/45">
              <span>{ecoPercent.toFixed(0)}% used</span>
              {resetAt && <span>Resets {fmtDate(resetAt)}</span>}
            </div>
            {ecoPercent >= 90 && (
              <Badge variant="destructive" className="text-xs">
                {ecoPercent >= 100 ? "Limit reached" : "Almost at limit"}
              </Badge>
            )}
          </CardContent>
        </Card>

        {/* Publish Lines */}
        <Card className="bg-workspace-surface border-white/[0.07]">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Send className="h-4 w-4 text-blue-500" />
              Publishes / month
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className={`text-2xl font-bold tabular-nums ${getUsageColor(publishLinesPercent)}`}>
                {fmtNum(limits?.publish_lines_used ?? 0)}
              </span>
              <span className="text-sm text-white/45">
                / {fmtNum(limits?.publish_lines_limit ?? 30)} per month
              </span>
            </div>
            <Progress value={publishLinesPercent} className={`h-2 ${getProgressColor(publishLinesPercent)}`} />
            <div className="flex items-center justify-between text-xs text-white/45">
              <span>{publishLinesPercent}% used</span>
              {limits?.publish_lines_reset_at && (
                <span>Resets {fmtDate(limits.publish_lines_reset_at)}</span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Resource Summary ────────────────────────────────────────────── */}
      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Resource Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="flex items-center gap-2.5">
              <Users className="h-4 w-4 text-white/45" />
              <div>
                <p className="text-sm font-semibold">{limits?.seats_used ?? 0} / {limits?.seats_total ?? 1}</p>
                <p className="text-xs text-white/45">Seats</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <FolderKanban className="h-4 w-4 text-white/45" />
              <div>
                <p className="text-sm font-semibold">
                  {(limits?.max_projects ?? 1) >= 999999 ? "Unlimited" : `${limits?.max_projects ?? 1}`}
                </p>
                <p className="text-xs text-white/45">Projects</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <Zap className="h-4 w-4 text-white/45" />
              <div>
                <p className="text-sm font-semibold">
                  {ecoLimit < 0 ? "∞" : fmtNum(ecoLimit)}
                </p>
                <p className="text-xs text-white/45">Eco / month</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <Send className="h-4 w-4 text-white/45" />
              <div>
                <p className="text-sm font-semibold">{fmtNum(limits?.publish_lines_limit ?? 30)}</p>
                <p className="text-xs text-white/45">Publish / mo</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Feature Availability ────────────────────────────────────────── */}
      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Feature Access</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {FEATURE_ROWS.map(({ key, label, icon: Icon }) => {
              const enabled = hasFeature(key);
              return (
                <div
                  key={key}
                  className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm ${
                    enabled ? "text-white/85" : "text-white/45/60"
                  }`}
                >
                  <Icon className={`h-4 w-4 ${enabled ? "text-primary" : "text-white/45/40"}`} />
                  <span className="flex-1">{label}</span>
                  {enabled ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <X className="h-3.5 w-3.5 text-white/45/30" />
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── Plan Comparison ─────────────────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-medium mb-3">Compare Plans</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {PLAN_CARDS.map((plan) => {
            const isCurrent = tier === plan.id;
            return (
              <Card
                key={plan.id}
                className={`relative ${
                  isCurrent
                    ? "border-primary/50 ring-1 ring-primary/20"
                    : "border-white/[0.07]"
                } ${"popular" in plan && plan.popular ? "shadow-sm" : ""}`}
              >
                {isCurrent && (
                  <Badge className="absolute -top-2.5 left-3 text-[10px]">Current</Badge>
                )}
                {"popular" in plan && plan.popular && !isCurrent && (
                  <Badge variant="secondary" className="absolute -top-2.5 left-3 text-[10px]">
                    Popular
                  </Badge>
                )}
                <CardContent className="p-4 pt-5 space-y-3">
                  <div>
                    <p className="text-sm font-semibold">{TIER_LABELS[plan.id]}</p>
                    <div className="flex items-baseline gap-1 mt-1">
                      <span className="text-xl font-bold">{plan.price}</span>
                      <span className="text-xs text-white/45">{plan.priceNote}</span>
                    </div>
                  </div>
                  <ul className="space-y-1.5">
                    {plan.highlights.map((h) => (
                      <li key={h} className="flex items-center gap-1.5 text-xs text-white/45">
                        <CheckCircle2 className="h-3 w-3 text-primary shrink-0" />
                        {h}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* ── Support Link ────────────────────────────────────────────────── */}
      <p className="text-xs text-white/45 text-center">
        Questions? Contact{" "}
        <a href="mailto:info@ecomgear.dev" className="text-primary hover:underline">
          info@ecomgear.dev
        </a>
      </p>
    </div>
  );
};
