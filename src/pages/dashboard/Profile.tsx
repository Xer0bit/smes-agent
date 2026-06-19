import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Loader2, User } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { useUsage } from '@/contexts/UsageContext';
import { useSubscription } from '@/contexts/SubscriptionContext';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  suspended: 'Payment Required',
  cancelled: 'Cancelled',
};

const PAYMENT_STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default',
  suspended: 'destructive',
  cancelled: 'secondary',
};

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  professional: 'Professional',
  enterprise: 'Enterprise',
  // canonical DB names
  pro: 'Professional',
  agency: 'Enterprise',
};

export default function DashboardProfile() {
  const [user, setUser] = useState<SupabaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { usageRecord, getUsagePercentage, getUsageLimit, refreshUsage } = useUsage();
  const { subscribed, planTier, status, loading: subscriptionLoading } = useSubscription();

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    refreshUsage();

    const handleFocus = () => {
      refreshUsage();
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [refreshUsage]);

  const checkAuth = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      navigate('/auth');
      return;
    }
    setUser(session.user);
    setFullName(session.user.user_metadata?.full_name || '');
    
    // Load profile data from profiles table
    const { data: profile } = await supabase
      .from('profiles')
      .select('phone')
      .eq('id', session.user.id)
      .single();
    
    if (profile) {
      setPhone(profile.phone || '');
    }
    
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Update user metadata (full name)
      const { error: authError } = await supabase.auth.updateUser({
        data: { full_name: fullName }
      });

      if (authError) throw authError;

      // Update profile data (phone)
      if (user) {
        const { error: profileError } = await supabase
          .from('profiles')
          .update({ phone })
          .eq('id', user.id);

        if (profileError) throw profileError;
      }

      toast({
        title: "Success",
        description: "Profile updated successfully",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl p-6 sm:p-8">
      <DashboardPageHeader
        title={t('dashboard.profile')}
        description="Account, usage, and billing."
      />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card className="rounded-none">
          <CardContent className="p-5">
            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Email</p>
            <p className="mt-3 text-sm font-medium text-foreground break-all">{user?.email || 'No email'}</p>
          </CardContent>
        </Card>
        <Card className="rounded-none">
          <CardContent className="p-5">
            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Eco</p>
            <p className="mt-3 text-xl font-semibold text-foreground">
              {new Intl.NumberFormat('en-US').format(usageRecord?.ai_gens_used || 0)} / {new Intl.NumberFormat('en-US').format(getUsageLimit())}
            </p>
            <Progress value={getUsagePercentage()} className="mt-3 h-1.5" />
          </CardContent>
        </Card>
        <Card className="rounded-none">
          <CardContent className="p-5">
            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Plan</p>
            {subscriptionLoading ? (
              <p className="mt-3 text-sm text-muted-foreground">Loading...</p>
            ) : (
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xl font-semibold text-foreground">{PLAN_LABELS[planTier || 'free'] || 'Free'}</p>
                <Badge variant={PAYMENT_STATUS_VARIANTS[status || 'active'] || 'secondary'}>
                  {PAYMENT_STATUS_LABELS[status || 'active'] || 'Unknown'}
                </Badge>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Profile
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={user?.email || ''}
              disabled
              className="bg-muted rounded-none"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="fullName">Full Name</Label>
            <Input
              id="fullName"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Full name"
              className="rounded-none"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone">Phone Number</Label>
            <Input
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Phone number"
              className="rounded-none"
            />
          </div>

          <div className="flex flex-wrap gap-3">
            <Button onClick={handleSave} disabled={saving} className="rounded-none">
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
            <Button variant="outline" className="rounded-none" onClick={() => navigate('/dashboard/settings')}>
              Billing & Security
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
