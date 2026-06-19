import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";
import { normalizeTier } from "@/hooks/useSubscription";
import { Loader2, CreditCard, CheckCircle2, Calendar, DollarSign } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

interface OrganizationBillingContentProps {
  organizationId: string;
  userRole: string;
}

// Subscription plans configuration with actual Stripe IDs
interface SubscriptionPlan {
  name: string;
  subtitle?: string;
  price: string;
  priceId: string | null;
  productId: string | null;
  isAgency?: boolean;
  features: string[];
}

const SUBSCRIPTION_PLANS: Record<string, SubscriptionPlan> = {
  free: {
    name: "Free",
    subtitle: "Basic",
    price: "$0",
    priceId: null,
    productId: null,
    features: [
      "1 seat",
      "1 project",
      "10 eco per month",
      "Basic project management"
    ]
  },
  starter: {
    name: "Starter",
    subtitle: "Small team",
    price: "$9.99",
    priceId: "price_1TAmb4Ckmi49M8D1I4VOHjjp",
    productId: "starter",
    features: [
      "3 seats",
      "5 projects",
      "100 eco per month",
      "Custom domains",
      "Collaborator access"
    ]
  },
  professional: {
    name: "Professional",
    subtitle: "Growing product team",
    price: "$49",
    priceId: "price_1TAmb6Ckmi49M8D1dt2flpNM",
    productId: "professional",
    features: [
      "10 seats",
      "Unlimited projects",
      "100 eco per month",
      "Remove branding",
      "Analytics and API access"
    ]
  },
  enterprise: {
    name: "Enterprise",
    subtitle: "Scale without limits",
    price: "Custom",
    priceId: null,
    productId: "enterprise",
    isAgency: true,
    features: [
      "Unlimited seats",
      "Unlimited projects",
      "100 eco per month",
      "Dedicated support",
      "SSO and SLA",
      "Custom contracts and design systems"
    ]
  }
};

export function OrganizationBillingContent({ organizationId, userRole }: OrganizationBillingContentProps) {
  const { toast } = useToast();
  const location = useLocation();
  const { billingInfo, loading, error, refreshBilling } = useOrganizationBilling(organizationId);
  const [processingCheckout, setProcessingCheckout] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [addingPayment, setAddingPayment] = useState(false);
  
  // Subscription confirmation state
  const [showSubscribeConfirm, setShowSubscribeConfirm] = useState(false);
  const [selectedPlanForSubscribe, setSelectedPlanForSubscribe] = useState<SubscriptionPlan | null>(null);
  const [agreedToTerms, setAgreedToTerms] = useState(false);

  // Check if user has billing permissions
  const canAccessBilling = userRole === 'admin' || userRole === 'billing_admin';

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const isBillingReturn = params.get('billing_success') === 'true' || params.get('payment_setup') === 'success';

    if (!isBillingReturn) return;

    refreshBilling();
    toast({
      title: 'Billing updated',
      description: 'Stripe payment details were refreshed successfully.',
    });
  }, [location.search, refreshBilling, toast]);

  if (!canAccessBilling) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground">You don't have permission to access billing information.</p>
          <p className="text-sm text-muted-foreground mt-2">Contact your organization admin for access.</p>
        </CardContent>
      </Card>
    );
  }

  const handleSubscribe = async (priceId: string) => {
    try {
      setProcessingCheckout(true);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      const lovableCloudUrl = import.meta.env.VITE_SUPABASE_URL ;
      const response = await fetch(`${lovableCloudUrl}/functions/v1/org-create-checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-external-authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ priceId, organization_id: organizationId }),
      });

      const data = await response.json();

      if (!response.ok || data?.error) {
        throw new Error(data?.error || 'Failed to create checkout session');
      }

      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } catch (err: any) {
      toast({
        title: "Checkout Error",
        description: err.message || "Failed to create checkout session",
        variant: "destructive"
      });
    } finally {
      setProcessingCheckout(false);
    }
  };

  const handleManageSubscription = async () => {
    try {
      setOpeningPortal(true);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      const lovableCloudUrl = import.meta.env.VITE_SUPABASE_URL;
      const response = await fetch(`${lovableCloudUrl}/functions/v1/org-customer-portal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-external-authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ organization_id: organizationId }),
      });

      const data = await response.json();

      if (!response.ok || data?.error) {
        throw new Error(data?.error || 'Failed to open customer portal');
      }

      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } catch (err: any) {
      toast({
        title: "Portal Error",
        description: err.message || "Failed to open customer portal",
        variant: "destructive"
      });
    } finally {
      setOpeningPortal(false);
    }
  };

  const handleBookDemo = () => {
    window.open('mailto:info@ecomgear.dev?subject=Enterprise%20Demo%20Request', '_blank', 'noopener,noreferrer');
  };

  const handleAddPaymentMethod = async () => {
    try {
      setAddingPayment(true);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      const lovableCloudUrl = import.meta.env.VITE_SUPABASE_URL ;
      const response = await fetch(`${lovableCloudUrl}/functions/v1/org-setup-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-external-authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ organization_id: organizationId }),
      });

      const data = await response.json();

      if (!response.ok || data?.error) {
        throw new Error(data?.error || 'Failed to create setup session');
      }

      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } catch (err: any) {
      toast({
        title: "Setup Error",
        description: err.message || "Failed to open payment setup",
        variant: "destructive"
      });
    } finally {
      setAddingPayment(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-destructive">Failed to load billing information</p>
          <Button onClick={refreshBilling} className="mt-4" variant="outline">
            Try Again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const currentTier = normalizeTier(billingInfo?.subscription_tier) || 'free';
  const currentMonthTotal = billingInfo?.current_month?.total || 0;
  const currentPlan = SUBSCRIPTION_PLANS[currentTier];

  return (
    <div className="space-y-6">
      {/* Current Billing Information */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Current Plan</CardTitle>
              <CardDescription>{billingInfo?.organization_name}</CardDescription>
            </div>
            <Badge variant={currentTier === 'free' ? 'secondary' : 'default'} className="text-base px-4 py-1">
              {currentPlan?.name || 'Unknown Plan'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <DollarSign className="h-4 w-4" />
                <span>Current Month Cost</span>
              </div>
              <p className="text-2xl font-bold">${currentMonthTotal.toFixed(2)}</p>
            </div>
            {billingInfo?.stripe_customer_id && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CreditCard className="h-4 w-4" />
                  <span>Payment Method</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleManageSubscription}
                  disabled={openingPortal}
                >
                  {openingPortal ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <CreditCard className="h-4 w-4 mr-2" />
                  )}
                  Manage Payment
                </Button>
              </div>
            )}
          </div>

          {/* Project-level costs breakdown */}
          {billingInfo?.current_month?.projects && billingInfo.current_month.projects.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-medium mb-2">Project Costs Breakdown</h4>
              <div className="space-y-2">
                {billingInfo.current_month.projects.map((project: any) => (
                  <div key={project.project_id} className="border rounded-lg p-3">
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-medium">{project.project_name}</span>
                      <span className="font-semibold">${project.total.toFixed(2)}</span>
                    </div>
                    {project.add_ons && project.add_ons.length > 0 && (
                      <div className="space-y-1 text-sm text-muted-foreground">
                        {project.add_ons.map((addOn: any, idx: number) => (
                          <div key={idx} className="flex justify-between">
                            <span>{addOn.name} × {addOn.quantity}</span>
                            <span>${addOn.cost.toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payment Method Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5" />
            Payment Method
          </CardTitle>
          <CardDescription>
            Add or manage your payment method for subscriptions and add-ons
          </CardDescription>
        </CardHeader>
        <CardContent>
          {billingInfo?.stripe_customer_id ? (
            <Button 
              variant="outline"
              onClick={handleManageSubscription}
              disabled={openingPortal}
            >
              {openingPortal ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <CreditCard className="h-4 w-4 mr-2" />
              )}
              Manage Payment Method
            </Button>
          ) : (
            <Button 
              onClick={handleAddPaymentMethod}
              disabled={addingPayment}
            >
              {addingPayment ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <CreditCard className="h-4 w-4 mr-2" />
              )}
              Add Payment Method
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Recent Invoices */}
      {billingInfo?.recent_invoices && billingInfo.recent_invoices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Invoices</CardTitle>
            <CardDescription>Your recent billing history</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {billingInfo.recent_invoices.slice(0, 5).map((invoice: any) => (
                  <TableRow key={invoice.id}>
                    <TableCell className="font-mono text-sm">{invoice.invoice_number}</TableCell>
                    <TableCell>{new Date(invoice.created_at).toLocaleDateString()}</TableCell>
                    <TableCell>${invoice.total.toFixed(2)}</TableCell>
                    <TableCell>
                      <Badge variant={invoice.status === 'paid' ? 'default' : 'secondary'}>
                        {invoice.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Subscription Plans */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Available Plans</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Object.entries(SUBSCRIPTION_PLANS).map(([tier, plan]: [string, SubscriptionPlan]) => {
            const isCurrent = currentTier === tier;
            
            return (
              <Card key={tier} className={isCurrent ? 'border-primary' : ''}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{plan.name}</CardTitle>
                    {isCurrent && <Badge>Current Plan</Badge>}
                  </div>
                  {plan.subtitle && (
                    <CardDescription>{plan.subtitle}</CardDescription>
                  )}
                  <div className="mt-2">
                    <span className="text-3xl font-bold">{plan.price}</span>
                    {plan.price !== "Custom" && plan.price !== "$0" && (
                      <span className="text-muted-foreground">/month</span>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ul className="space-y-2">
                    {plan.features.map((feature, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-sm">
                        <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  {!isCurrent && (
                    <div className="pt-4">
                      {plan.isAgency ? (
                        <Button className="w-full" onClick={handleBookDemo}>
                          <Calendar className="h-4 w-4 mr-2" />
                          Book a Demo
                        </Button>
                      ) : plan.priceId ? (
                        <Button
                          className="w-full"
                          onClick={() => {
                            setSelectedPlanForSubscribe(plan);
                            setAgreedToTerms(false);
                            setShowSubscribeConfirm(true);
                          }}
                          disabled={processingCheckout}
                        >
                          Subscribe to {plan.name}
                        </Button>
                      ) : null}
                    </div>
                  )}

                  {isCurrent && currentTier !== 'free' && (
                    <div className="pt-4 space-y-2">
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={handleManageSubscription}
                        disabled={openingPortal}
                      >
                        {openingPortal ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : null}
                        Manage Subscription
                      </Button>
                    </div>
                  )}
                  
                  {currentTier !== 'free' && tier === 'free' && (
                    <div className="pt-4">
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={handleManageSubscription}
                        disabled={openingPortal}
                      >
                        Downgrade to Free
                      </Button>
                      <p className="text-xs text-muted-foreground mt-2 text-center">
                        Your paid features will remain active until the end of your billing period
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Subscription Confirmation Dialog */}
      <Dialog open={showSubscribeConfirm} onOpenChange={setShowSubscribeConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Subscribe to {selectedPlanForSubscribe?.name}</DialogTitle>
            <DialogDescription>
              Review your subscription details before proceeding to checkout
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="text-center p-4 bg-muted rounded-lg">
              <p className="text-sm text-muted-foreground mb-1">Monthly Charge</p>
              <p className="text-3xl font-bold">
                {selectedPlanForSubscribe?.price}
                <span className="text-lg font-normal text-muted-foreground">/month</span>
              </p>
            </div>
            
            <div className="border rounded-lg p-4">
              <h4 className="font-medium mb-3">What's included:</h4>
              <ul className="space-y-2">
                {selectedPlanForSubscribe?.features.map((feature, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex items-start space-x-2 p-3 bg-muted/50 rounded-lg">
              <Checkbox 
                id="terms" 
                checked={agreedToTerms} 
                onCheckedChange={(checked) => setAgreedToTerms(checked === true)}
              />
              <label htmlFor="terms" className="text-sm leading-relaxed cursor-pointer">
                I agree to the ongoing monthly charge of {selectedPlanForSubscribe?.price} and the Terms of Service
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setShowSubscribeConfirm(false);
                setAgreedToTerms(false);
              }}
            >
              Cancel
            </Button>
            <Button 
              onClick={() => {
                setShowSubscribeConfirm(false);
                handleSubscribe(selectedPlanForSubscribe?.priceId!);
              }}
              disabled={!agreedToTerms || processingCheckout}
            >
              {processingCheckout ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <CreditCard className="h-4 w-4 mr-2" />
              )}
              Proceed to Checkout
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
