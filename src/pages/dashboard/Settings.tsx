import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Settings as SettingsIcon, Lock, Cloud, Globe, Smartphone, CreditCard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { z } from 'zod';
import { useSubscription } from '@/contexts/SubscriptionContext';
import { useOrganization } from '@/contexts/OrganizationContext';
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
  const { currentOrganizationId } = useOrganization();
  const { subscribed, planTier, status, loading } = useSubscription();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);

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
          <Card className="rounded-none">
            <CardContent className="p-5">
              <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Workspace</p>
              <p className="mt-3 text-sm font-medium text-foreground">{currentOrganizationId ? 'Connected' : 'Not selected'}</p>
            </CardContent>
          </Card>
          <Card className="rounded-none">
            <CardContent className="p-5">
              <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Plan</p>
              <p className="mt-3 text-sm font-medium text-foreground">{PLAN_LABELS[planTier || 'free'] || 'Free'}</p>
            </CardContent>
          </Card>
          <Card className="rounded-none">
            <CardContent className="p-5">
              <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Status</p>
              <div className="mt-3">
                <Badge variant={STATUS_VARIANTS[status || 'active'] || 'secondary'}>
                  {STATUS_LABELS[status || 'active'] || status || 'Unknown'}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="rounded-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SettingsIcon className="h-5 w-5" />
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

        <Card className="rounded-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              Billing
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!currentOrganizationId ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">Select a workspace to view billing.</p>
                <Button onClick={() => navigate('/dashboard/organizations')} variant="outline" className="rounded-none">
                  Go to Organizations
                </Button>
              </div>
            ) : loading ? (
              <p className="text-sm text-muted-foreground">Loading payment status...</p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-4 border p-4">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Current plan</p>
                    <p className="text-lg font-semibold">{PLAN_LABELS[planTier || 'free'] || 'Free'}</p>
                  </div>
                  <Badge variant={STATUS_VARIANTS[status || 'active'] || 'secondary'}>
                    {STATUS_LABELS[status || 'active'] || status || 'Unknown'}
                  </Badge>
                </div>

                <div className="border p-4 space-y-1">
                  <p className="text-sm text-muted-foreground">Access</p>
                  <p className="text-sm font-medium">
                    {subscribed
                      ? 'Your organization has an active paid subscription.'
                      : 'Your organization is currently on the free plan.'}
                  </p>
                  {status === 'suspended' && (
                    <p className="text-sm text-destructive">
                      Payment is overdue. Update billing to restore full access.
                    </p>
                  )}
                </div>

                <Button onClick={() => navigate('/dashboard/organizations')} className="rounded-none">
                  Manage Billing
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
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
                  className="rounded-none"
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
                  className="rounded-none"
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
                  className="rounded-none"
                />
              </div>

              <Button 
                type="submit" 
                disabled={isChangingPassword}
                className="w-full rounded-none"
              >
                {isChangingPassword ? "Changing Password..." : "Change Password"}
              </Button>
            </form>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
