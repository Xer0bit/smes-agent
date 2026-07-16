import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { useOrganization } from "@/contexts/OrganizationContext";
import { CheckCircle2, Loader2, CreditCard, Building2, ArrowRight } from "lucide-react";
import { useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { SettingsSkeleton } from "./SettingsSkeleton";

const PLAN_COPY: Record<string, { name: string; price: string; features: string[] }> = {
  free: {
    name: 'Free',
    price: '$0',
    features: ['1 seat', '1 project', '10 eco / month'],
  },
  starter: {
    name: 'Starter',
    price: '$9.99',
    features: ['3 seats', '5 projects', '100 eco / month'],
  },
  professional: {
    name: 'Professional',
    price: '$49',
    features: ['10 seats', 'Unlimited projects', '100 eco / month'],
  },
  enterprise: {
    name: 'Enterprise',
    price: 'Custom',
    features: ['Unlimited seats', 'Unlimited projects', '100 eco / month'],
  },
};

export const SubscriptionContent = () => {
  const { subscribed, planTier, status, loading } = useSubscription();
  const { currentOrganizationId } = useOrganization();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    const success = searchParams.get('success');
    const canceled = searchParams.get('canceled');

    if (success === 'true') {
      toast({
        title: 'Success!',
        description: 'Billing setup completed successfully.',
      });
    } else if (canceled === 'true') {
      toast({
        title: 'Canceled',
        description: 'Subscription checkout was canceled.',
        variant: 'destructive',
      });
    }
  }, [searchParams]);

  const currentPlan = PLAN_COPY[planTier || 'free'];

  if (loading) {
    return <SettingsSkeleton cards={2} />;
  }

  // Show message if user has no organization
  if (!currentOrganizationId) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold">Subscription Plans</h2>
          <p className="text-white/45">Manage your subscription and billing</p>
        </div>

        <Card className="bg-workspace-surface border-indigo-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              Organization Required
            </CardTitle>
            <CardDescription>
              Create or join an organization to access subscription plans
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-white/45">
              Subscription plans are managed at the organization level. You need to create or be part of an organization to subscribe to a plan.
            </p>
            <Button 
              onClick={() => navigate('/dashboard/organizations')}
              className="w-full"
            >
              <Building2 className="mr-2 h-4 w-4" />
              Go to Organizations
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Workspace Billing</h2>
        <p className="text-white/45">Billing and plan management are handled at the organization level.</p>
      </div>

      <Card className="bg-workspace-surface border-indigo-500/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-primary" />
            Current Organization Plan
          </CardTitle>
          <CardDescription>
            {status ? `Status: ${status}` : 'No billing status available'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-lg font-semibold">{currentPlan?.name || 'Free'}</div>
              <div className="text-sm text-white/45">{currentPlan?.price || '$0'}{currentPlan?.price !== '$0' && currentPlan?.price !== 'Custom' ? '/month' : ''}</div>
            </div>
            <Badge variant={subscribed ? 'default' : 'secondary'}>
              {subscribed ? 'Paid' : 'Free'}
            </Badge>
          </div>
          <ul className="space-y-2">
            {(currentPlan?.features || []).map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
          <Button onClick={() => navigate('/dashboard/organizations')} className="w-full sm:w-auto">
            <CreditCard className="mr-2 h-4 w-4" />
            Manage Organization Billing
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </CardContent>
      </Card>

      {subscribed && (
        <Card className="bg-indigo-500/[0.05] border-indigo-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-primary" />
              Active Paid Plan
            </CardTitle>
            <CardDescription>
              Billing, upgrades, and payment methods are managed from the organization workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate('/dashboard/organizations')} variant="outline">
              <CreditCard className="mr-2 h-4 w-4" />
              Open Billing Workspace
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle>Need Help?</CardTitle>
          <CardDescription>
            Contact our support team if you have questions about subscriptions
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <a href="mailto:info@ecomgear.dev">Contact Support</a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};
