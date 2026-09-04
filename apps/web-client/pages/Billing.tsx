import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import BrandLoader from '@/components/BrandLoader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  CreditCard,
  Crown,
  Zap,
  Check,
  ArrowRight,
  Sparkles,
  ShieldCheck,
  BarChart3,
  Loader2,
  ArrowLeft,
} from 'lucide-react';
import { toast } from 'sonner';

interface Profile {
  id: string;
  subscription_tier?: string;
  stripe_customer_id?: string;
  email?: string;
}

export default function Billing() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Mock usage stat for free tier display
  const tokensUsed = 340000;
  const tokenLimit = 500000;
  const usagePercentage = Math.min(100, Math.round((tokensUsed / tokenLimit) * 100));

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate('/auth');
        return;
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching profile:', error);
      }

      setProfile(data || { id: session.user.id, subscription_tier: 'free', email: session.user.email });
    } catch (err) {
      console.error('Failed to load profile:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleUpgrade = () => {
    const paymentLink = import.meta.env.VITE_STRIPE_PAYMENT_LINK || 'https://buy.stripe.com/test_SMEsAgentPro';
    if (!paymentLink) {
      toast.error('Stripe payment link is not configured yet.');
      return;
    }
    window.location.href = paymentLink;
  };

  const isPro = (profile?.subscription_tier || '').toLowerCase() === 'pro';

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <BrandLoader variant="bead" size={100} label="Loading subscription" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-6 md:p-12">
      <div className="max-w-5xl mx-auto space-y-8">
        
        {/* Navigation & Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/dashboard')}
              className="rounded-full border-border bg-muted text-foreground/80 hover:bg-accent hover:text-white"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Dashboard
            </Button>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-white flex items-center gap-3">
                <CreditCard className="h-7 w-7 text-muted-foreground" />
                Billing & Subscription
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Manage your usage quotas, plan tier, and payment details
              </p>
            </div>
          </div>

          <Badge
            variant="outline"
            className={`px-3 py-1 text-sm font-semibold rounded-full border ${
              isPro
                ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                : 'border-border bg-accent/60 text-foreground/80'
            }`}
          >
            {isPro ? (
              <span className="flex items-center gap-1.5">
                <Crown className="h-4 w-4 text-amber-400" />
                PRO TIER ACTIVE
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <Zap className="h-4 w-4 text-muted-foreground" />
                FREE TIER
              </span>
            )}
          </Badge>
        </div>

        {/* Current Plan Overview & Usage Card */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="md:col-span-2 border-border bg-muted/60 backdrop-blur-sm text-foreground">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg font-semibold flex items-center justify-between">
                <span>Usage & Monthly Allowance</span>
                <BarChart3 className="h-5 w-5 text-muted-foreground" />
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {isPro
                  ? 'Your Pro subscription includes unlimited AI code generation runs.'
                  : 'Free tier includes 500,000 AI tokens ($5.00 limit) per 30-day cycle.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {!isPro ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-foreground/80">Free Tier: Token Usage</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {tokensUsed.toLocaleString()} / {tokenLimit.toLocaleString()} tokens ({usagePercentage}%)
                    </span>
                  </div>
                  <Progress value={usagePercentage} className="h-2.5 bg-accent text-muted-foreground" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    💡 When limit is reached, AI generation is paused until the next cycle or upgrade to Pro.
                  </p>
                </div>
              ) : (
                <div className="p-4 rounded-none border border-emerald-500/20 bg-emerald-500/10 flex items-center gap-3">
                  <ShieldCheck className="h-6 w-6 text-emerald-400 shrink-0" />
                  <div>
                    <h4 className="text-sm font-semibold text-emerald-300">Unlimited Pro AI Access Active</h4>
                    <p className="text-xs text-emerald-400/80 mt-0.5">
                      You are enjoying unlimited high-speed code generation with Claude 3.5 Sonnet & Gemini 1.5 Pro.
                    </p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4 pt-2">
                <div className="p-4 rounded-none border border-border bg-muted/60">
                  <span className="text-xs text-muted-foreground">Current Plan</span>
                  <p className="text-lg font-bold text-white mt-1 capitalize">{profile?.subscription_tier || 'Free'} Tier</p>
                </div>
                <div className="p-4 rounded-none border border-border bg-muted/60">
                  <span className="text-xs text-muted-foreground">Billing Cycle</span>
                  <p className="text-lg font-bold text-white mt-1">Monthly</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Quick Upgrade Callout */}
          <Card className="border-border bg-gradient-to-b from-muted/40 via-muted/60 to-background text-foreground flex flex-col justify-between">
            <CardHeader>
              <CardTitle className="text-lg font-bold text-white flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-muted-foreground" />
                {isPro ? 'Pro Member' : 'Upgrade to Pro'}
              </CardTitle>
              <CardDescription className="text-foreground/80">
                Unlock full capacity for building production web applications.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="text-3xl font-extrabold text-white">
                $20 <span className="text-sm font-normal text-muted-foreground">/ month</span>
              </div>
              <ul className="space-y-2 text-xs text-foreground/80">
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span>Unlimited AI token runs</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span>One-click Vercel Edge publishing</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span>Priority MicroVM execution</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span>Vision model wireframe parsing</span>
                </li>
              </ul>
              {!isPro ? (
                <Button
                  onClick={handleUpgrade}
                  className="w-full bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 text-white font-semibold shadow-lg shadow-black/20 rounded-none h-11 transition-all"
                >
                  <span>Upgrade to Pro</span>
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={handleUpgrade}
                  className="w-full border-border bg-accent text-foreground hover:bg-accent rounded-none h-11"
                >
                  Manage Subscription
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
