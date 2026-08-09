import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Settings as SettingsIcon, Lock, CreditCard, User, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { z } from 'zod';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { useSubscription } from '@/contexts/SubscriptionContext';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useUsage } from '@/contexts/UsageContext';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  suspended: 'Payment Required',
  cancelled: 'Cancelled',
};

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
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

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(6, "Password must be at least 6 characters"),
  confirmPassword: z.string().min(1, "Please confirm your password")
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"]
});

export default function DashboardSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const billingCardRef = useRef<HTMLDivElement>(null);
  const { currentOrganizationId } = useOrganization();
  const { planTier, status, loading } = useSubscription();
  const { usageRecord, getUsagePercentage, getUsageLimit, refreshUsage } = useUsage();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  // Editor settings panels deep-link here as `?section=workspace-plans` (the same
  // section id used by the project SettingsSidebar) expecting to land on Billing.
  // This page only has one section that id can mean; scroll it into view.
  useEffect(() => {
    if (searchParams.get('section') !== 'workspace-plans') return;
    billingCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [searchParams]);

  // Merged from the former dashboard/profile page (removed   this page now
  // covers account + billing + security in one place).
  const [authUser, setAuthUser] = useState<SupabaseUser | null>(null);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    refreshUsage();
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      setAuthUser(session.user);
      setFullName(session.user.user_metadata?.full_name || '');
      const { data: profile } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', session.user.id)
        .single();
      if (profile) setPhone(profile.phone || '');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    try {
      const { error: authError } = await supabase.auth.updateUser({ data: { full_name: fullName } });
      if (authError) throw authError;
      if (authUser) {
        const { error: profileError } = await supabase.from('profiles').update({ phone }).eq('id', authUser.id);
        if (profileError) throw profileError;
      }
      toast.success('Profile updated');
    } catch (error: any) {
      toast.error(error.message || 'Failed to update profile');
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      // Validate inputs
      passwordSchema.parse({
        currentPassword,
        newPassword,
        confirmPassword
      });

      setIsChangingPassword(true);

      // First verify current password by signing in
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.email) {
        toast.error("User email not found");
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword
      });

      if (signInError) {
        toast.error("Current password is incorrect");
        return;
      }

      // Update password
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword
      });

      if (updateError) {
        toast.error(updateError.message);
        return;
      }

      toast.success("Password changed successfully");
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      if (error instanceof z.ZodError) {
        toast.error(error.errors[0].message);
      } else {
        toast.error("Failed to change password");
      }
    } finally {
      setIsChangingPassword(false);
    }
  };


  return (
    <div className="max-w-7xl p-6 sm:p-8">
      <DashboardPageHeader
        title={t('dashboard.settings')}
        description="Workspace billing and account security."
      />

      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="rounded-xl border-border/60 shadow-[0_8px_24px_hsl(220_45%_5%/0.16)]">
            <CardContent className="p-5">
              <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Email</p>
              <p className="mt-3 truncate text-sm font-medium text-foreground">{authUser?.email || 'No email'}</p>
            </CardContent>
          </Card>
          <Card className="rounded-xl border-border/60 shadow-[0_8px_24px_hsl(220_45%_5%/0.16)]">
            <CardContent className="p-5">
              <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Eco</p>
              <p className="mt-3 font-display text-xl font-semibold text-foreground">
                {new Intl.NumberFormat('en-US').format(usageRecord?.ai_gens_used || 0)} / {new Intl.NumberFormat('en-US').format(getUsageLimit())}
              </p>
              <Progress value={getUsagePercentage()} className="mt-3 h-1.5" />
            </CardContent>
          </Card>
          <Card className="rounded-xl border-border/60 shadow-[0_8px_24px_hsl(220_45%_5%/0.16)]">
            <CardContent className="p-5">
              <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Plan</p>
              {loading ? (
                <p className="mt-3 text-sm text-muted-foreground">Loading...</p>
              ) : (
                <div className="mt-3 flex items-center justify-between gap-2">
                  <p className="font-display text-xl font-semibold text-foreground">{PLAN_LABELS[planTier || 'free'] || 'Free'}</p>
                  <Badge variant={STATUS_VARIANTS[status || 'active'] || 'secondary'} className="rounded-full">
                    {STATUS_LABELS[status || 'active'] || status || 'Unknown'}
                  </Badge>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="rounded-xl border-border/60 shadow-[0_8px_24px_hsl(220_45%_5%/0.16)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-display text-lg font-semibold">
              <User className="h-5 w-5 text-primary" />
              Profile
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fullName">Full Name</Label>
              <Input
                id="fullName"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Full name"
                className="rounded-lg"
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
                className="rounded-lg"
              />
            </div>
            <Button onClick={handleSaveProfile} disabled={savingProfile} className="rounded-full">
              {savingProfile && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </CardContent>
        </Card>

        <Card className="rounded-xl border-border/60 shadow-[0_8px_24px_hsl(220_45%_5%/0.16)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-display text-lg font-semibold">
              <SettingsIcon className="h-5 w-5 text-primary" />
              Preferences
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="notifications">Email Notifications</Label>
                <p className="text-sm text-muted-foreground">Project updates</p>
              </div>
              <Switch id="notifications" />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="marketing">Marketing Emails</Label>
                <p className="text-sm text-muted-foreground">Product updates</p>
              </div>
              <Switch id="marketing" />
            </div>
          </CardContent>
        </Card>

        <Card ref={billingCardRef} className="rounded-xl border-border/60 shadow-[0_8px_24px_hsl(220_45%_5%/0.16)] scroll-mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-display text-lg font-semibold">
              <CreditCard className="h-5 w-5 text-primary" />
              Billing
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!currentOrganizationId ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">Select a workspace to view billing.</p>
                <Button onClick={() => navigate('/dashboard/organizations')} variant="outline" className="rounded-full">
                  Go to Organizations
                </Button>
              </div>
            ) : loading ? (
              <p className="text-sm text-muted-foreground">Loading payment status...</p>
            ) : (
              <>
                {/* Plan + status already shown in the top summary row above   only
                    show something here if it's real, new information (the
                    suspended-payment warning), not a restated status claim. */}
                {status === 'suspended' && (
                  <div className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/[0.04] p-4">
                    <p className="text-sm font-medium text-destructive">Payment is overdue</p>
                    <p className="text-sm text-muted-foreground">Update billing to restore full access.</p>
                  </div>
                )}

                <p className="text-sm text-muted-foreground">
                  Manage your plan, payment method, and billing history from Organizations.
                </p>

                <Button onClick={() => navigate('/dashboard/organizations')} className="rounded-full">
                  Manage billing
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-xl border-border/60 shadow-[0_8px_24px_hsl(220_45%_5%/0.16)]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-display text-lg font-semibold">
              <Lock className="h-5 w-5 text-primary" />
              Security
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handlePasswordChange} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="current-password">Current Password</Label>
                <Input
                  id="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Current password"
                  disabled={isChangingPassword}
                  className="rounded-lg"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="new-password">New Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password"
                  disabled={isChangingPassword}
                  className="rounded-lg"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm New Password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm password"
                  disabled={isChangingPassword}
                  className="rounded-lg"
                />
              </div>

              <Button
                type="submit"
                disabled={isChangingPassword}
                className="w-full rounded-full"
              >
                {isChangingPassword ? "Changing password…" : "Change password"}
              </Button>
            </form>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
