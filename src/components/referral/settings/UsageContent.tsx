import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useUsage } from "@/contexts/UsageContext";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { Loader2, TrendingUp, Calendar, Zap, Send } from "lucide-react";
import { getUsageColor, getProgressColor } from "@/hooks/useUsage";
import { TIER_LIMITS, TIER_LABELS } from "@/services/subscriptionService";
import { SettingsSkeleton } from "./SettingsSkeleton";

export const UsageContent = () => {
  const { usageRecord, loading, refreshUsage, getUsagePercentage, getUsageLimit } = useUsage();
  const { subscribed, limits, publishLinesPercent } = useSubscription();

  if (loading) {
    return <SettingsSkeleton cards={2} />;
  }

  const limit = getUsageLimit();
  const percentage = getUsagePercentage();
  const resetAt = usageRecord?.ai_gens_reset_at;
  const isUnlimited = limit < 0;

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric' 
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Eco Usage</h2>
        <p className="text-white/45">Every AI action spends <span className="font-semibold text-primary">eco</span> — 1 eco per code action, 0.5 eco per general question.</p>
      </div>

      {/* Current Usage Card */}
      <Card className="bg-workspace-surface border-indigo-500/15">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            Eco Usage
          </CardTitle>
          <CardDescription>
            {resetAt && (
              <div className="flex items-center gap-2 mt-1">
                <Calendar className="h-3 w-3" />
                <span className="text-xs">
                  Resets on {formatDate(resetAt)}
                </span>
              </div>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Usage</span>
              <span className={`text-lg font-bold ${getUsageColor(percentage)}`}>
                {percentage.toFixed(1)}%
              </span>
            </div>

            {!isUnlimited && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-sm font-semibold">
                  <span>Monthly Eco Quota:</span>
                  <span className="text-primary">{new Intl.NumberFormat('en-US').format(limit)} eco / month</span>
                </div>
              </div>
            )}
            
            {!isUnlimited && (
              <>
                <Progress 
                  value={percentage} 
                  className={`h-3 ${getProgressColor(percentage)}`}
                />
                <div className="flex items-center justify-between text-xs text-white/45">
                  <span>{percentage.toFixed(1)}% used</span>
                  {percentage >= 80 && percentage < 100 && (
                    <Badge variant="outline" className="text-yellow-600 border-yellow-600">
                      Approaching Limit
                    </Badge>
                  )}
                  {percentage >= 100 && (
                    <Badge variant="destructive">
                      Limit Reached
                    </Badge>
                  )}
                </div>
              </>
            )}

            {isUnlimited && (
              <div className="flex items-center gap-2 text-sm text-primary">
                <Zap className="h-4 w-4" />
                <span className="font-medium">Monthly eco policy active</span>
              </div>
            )}
          </div>

          <Button 
            variant="outline" 
            size="sm" 
            onClick={refreshUsage}
            className="w-full"
          >
            Refresh Usage
          </Button>
        </CardContent>
      </Card>

      {/* Publish Lines Card */}
      {limits && (
        <Card className="bg-workspace-surface border-indigo-500/15">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Send className="h-5 w-5 text-primary" />
              Publish Lines
            </CardTitle>
            <CardDescription>
              Lines consumed when publishing your site. Resets monthly.
              {limits.publish_lines_reset_at && (
                <div className="flex items-center gap-2 mt-1">
                  <Calendar className="h-3 w-3" />
                  <span className="text-xs">Resets on {formatDate(limits.publish_lines_reset_at)}</span>
                </div>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-sm font-semibold">
              <span>Monthly Quota:</span>
              <span className="text-primary">
                {limits.publish_lines_used ?? 0} / {limits.publish_lines_limit} lines
              </span>
            </div>
            <Progress
              value={publishLinesPercent}
              className={`h-3 ${getProgressColor(publishLinesPercent)}`}
            />
            <div className="flex items-center justify-between text-xs text-white/45">
              <span>{publishLinesPercent}% used</span>
              {publishLinesPercent >= 80 && publishLinesPercent < 100 && (
                <Badge variant="outline" className="text-yellow-600 border-yellow-600">
                  Approaching Limit
                </Badge>
              )}
              {publishLinesPercent >= 100 && (
                <Badge variant="destructive">Limit Reached</Badge>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upgrade Prompt */}
      {!subscribed && percentage >= 80 && (
        <Card className="bg-indigo-500/[0.05] border-indigo-500/40">
          <CardHeader>
            <CardTitle className="text-lg">Need More Usage?</CardTitle>
            <CardDescription>
              Upgrade your organization plan for higher monthly limits.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button 
              onClick={() => {
                // Navigate to subscription page for upgrade
                window.location.href = '/dashboard/settings?section=workspace-plans';
              }}
              className="w-full"
            >
              <Zap className="mr-2 h-4 w-4" />
              Manage Billing
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Usage Tiers Info */}
      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle className="text-lg">Eco Limits by Plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {Object.entries(TIER_LIMITS).map(([tier, tierLimits], index, arr) => (
            <div
              key={tier}
              className={`flex justify-between items-center py-2 ${index < arr.length - 1 ? 'border-b' : ''}`}
            >
              <div>
                <p className="font-medium">{TIER_LABELS[tier] || tier}</p>
                <p className="text-xs text-white/45">
                  {tierLimits.seats_total >= 999999 ? 'Unlimited seats' : `${tierLimits.seats_total} seats`}
                  {' · '}
                  {tierLimits.max_projects >= 999999 ? 'Unlimited projects' : `${tierLimits.max_projects} projects`}
                </p>
              </div>
              <div className="text-right">
                <p className={`text-sm font-semibold ${tier === 'agency' ? 'text-primary' : ''}`}>
                  {(tierLimits as any).publish_lines_limit ?? '—'} lines / mo
                </p>
                <p className="text-xs text-white/45">
                  {tierLimits.ai_gens_limit >= 999999 ? '∞' : tierLimits.ai_gens_limit.toLocaleString()} eco / month
                </p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {usageRecord && (
        <Card className="bg-workspace-surface border-white/[0.07]">
          <CardHeader>
            <CardTitle className="text-lg">Current Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={subscribed ? 'default' : 'secondary'}>
              {TIER_LABELS[usageRecord.plan_tier] || usageRecord.plan_tier}
            </Badge>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
