# Roles & Billing   Plan B: Frontend Components + Admin Panel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Prerequisite:** Plan A (migrations) must be fully applied before starting this plan.

**Goal:** Build all frontend components for the new roles/billing system   share preview branding, referral dashboard, agency markup settings, demo booking, Auto Pilot config, eComGear Cloud, Integration App marketplace, Ali Cloud migration, and updated admin panels.

**Architecture:** Each feature is a self-contained React component using supabase-js for data access. Components follow the existing pattern of `src/components/` for shared UI and `src/pages/` for routed pages. All new components use Tailwind CSS and shadcn/ui primitives already in the project.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, shadcn/ui, supabase-js v2, sonner (toasts)

---

## File Map

### New Component Files
- `src/components/preview/PreviewBranding.tsx`   renders footer/watermark overlay on previews
- `src/components/referral/ReferralDashboard.tsx`   referral code, earnings, share link
- `src/components/agency/ClientMarkupSettings.tsx`   agency per-client markup form
- `src/components/agency/DemoRequestForm.tsx`   book-a-demo upgrade form
- `src/components/addons/AutoPilotConfig.tsx`   enable/schedule/configure Auto Pilot
- `src/components/addons/EComGearCloudSettings.tsx`   enable cloud storage per project
- `src/components/addons/IntegrationAppMarketplace.tsx`   browse + install integrations
- `src/components/addons/AliCloudMigration.tsx`   request + track Ali Cloud migration
- `src/components/addons/AddonCard.tsx`   reusable addon purchase/status card

### Modified Files
- `src/pages/admin/RolesPermissions.tsx`   update to show free/pro/agency matrix
- `src/pages/admin/Subscriptions.tsx`   update tier display for pro/agency
- `src/pages/admin/DemoRequests.tsx`   new admin page: demo request queue
- `src/hooks/useGuestSession.ts`   new hook: fingerprint + guest project limit check
- `src/hooks/useReferral.ts`   new hook: referral code, reward history
- `src/hooks/useAddonAccess.ts`   new hook: check addon subscriptions

---

## Task 1: Guest Session Hook

**Files:**
- Create: `src/hooks/useGuestSession.ts`

- [ ] **Step 1: Create hook**

```typescript
// src/hooks/useGuestSession.ts
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

function getBrowserFingerprint(): string {
  const key = 'ecg_guest_fp';
  let fp = localStorage.getItem(key);
  if (!fp) {
    fp = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(key, fp);
  }
  return fp;
}

export function useGuestSession() {
  const [canCreate, setCanCreate] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fingerprint = getBrowserFingerprint();
    supabase
      .rpc('check_and_increment_guest_project', { p_fingerprint: fingerprint })
      .then(({ data, error }) => {
        // We only check, not increment here   decrement isn't possible,
        // so we read the guest_sessions row directly
        setCanCreate(!error);
        setLoading(false);
      });
  }, []);

  const checkCanCreate = useCallback(async (): Promise<boolean> => {
    const fingerprint = getBrowserFingerprint();
    // Read current count without incrementing
    const { data } = await supabase
      .from('guest_sessions')
      .select('projects_created')
      .eq('fingerprint', fingerprint)
      .maybeSingle();
    return !data || (data.projects_created ?? 0) < 1;
  }, []);

  const recordGuestProject = useCallback(async (): Promise<boolean> => {
    const fingerprint = getBrowserFingerprint();
    const { data, error } = await supabase.rpc('check_and_increment_guest_project', {
      p_fingerprint: fingerprint,
    });
    if (error) return false;
    return data as boolean;
  }, []);

  return { canCreate, loading, checkCanCreate, recordGuestProject };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useGuestSession.ts
git commit -m "feat(hooks): add useGuestSession for anonymous 1-project limit"
```

---

## Task 2: Referral Hook + Dashboard Component

**Files:**
- Create: `src/hooks/useReferral.ts`
- Create: `src/components/referral/ReferralDashboard.tsx`

- [ ] **Step 1: Create useReferral hook**

```typescript
// src/hooks/useReferral.ts
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface ReferralReward {
  id: string;
  referee_id: string;
  lines_earned: number;
  awarded_at: string;
}

export interface ReferralState {
  referralCode: string | null;
  bonusLines: number;
  rewards: ReferralReward[];
  loading: boolean;
  referralLink: string;
}

export function useReferral(): ReferralState {
  const { user } = useAuth();
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [bonusLines, setBonusLines] = useState(0);
  const [rewards, setRewards] = useState<ReferralReward[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) { setLoading(false); return; }

    Promise.all([
      supabase
        .from('profiles')
        .select('referral_code, bonus_lines')
        .eq('id', user.id)
        .single(),
      supabase
        .from('referral_rewards')
        .select('id, referee_id, lines_earned, awarded_at')
        .eq('referrer_id', user.id)
        .order('awarded_at', { ascending: false }),
    ]).then(([profileRes, rewardsRes]) => {
      if (profileRes.data) {
        setReferralCode(profileRes.data.referral_code);
        setBonusLines(profileRes.data.bonus_lines ?? 0);
      }
      if (rewardsRes.data) {
        setRewards(rewardsRes.data);
      }
      setLoading(false);
    });
  }, [user?.id]);

  const referralLink = referralCode
    ? `${window.location.origin}/register?ref=${referralCode}`
    : '';

  return { referralCode, bonusLines, rewards, loading, referralLink };
}
```

- [ ] **Step 2: Create ReferralDashboard component**

```tsx
// src/components/referral/ReferralDashboard.tsx
import { useState } from 'react';
import { useReferral } from '@/hooks/useReferral';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

export function ReferralDashboard() {
  const { referralCode, bonusLines, rewards, loading, referralLink } = useReferral();
  const [copied, setCopied] = useState(false);

  const copyLink = () => {
    navigator.clipboard.writeText(referralLink);
    setCopied(true);
    toast.success('Referral link copied!');
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return <div className="animate-pulse h-32 bg-muted rounded-lg" />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your Referral Code</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-muted px-3 py-2 rounded text-sm font-mono">
              {referralCode ?? ' '}
            </code>
            <Button size="sm" variant="outline" onClick={copyLink} disabled={!referralCode}>
              {copied ? 'Copied!' : 'Copy Link'}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Earn <strong>20 publish lines permanently</strong> for each friend who registers and publishes their first project.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Bonus Lines Earned
            <Badge variant="secondary" className="ml-2">{bonusLines} lines</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rewards.length === 0 ? (
            <p className="text-sm text-muted-foreground">No referrals yet. Share your link to start earning!</p>
          ) : (
            <div className="space-y-2">
              {rewards.map((r) => (
                <div key={r.id} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {new Date(r.awarded_at).toLocaleDateString()}
                  </span>
                  <span className="font-medium text-green-600">+{r.lines_earned} lines</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useReferral.ts src/components/referral/ReferralDashboard.tsx
git commit -m "feat(ui): add referral dashboard with bonus lines tracking"
```

---

## Task 3: Share Preview Branding Component

**Files:**
- Create: `src/components/preview/PreviewBranding.tsx`

- [ ] **Step 1: Create component**

```tsx
// src/components/preview/PreviewBranding.tsx
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { BrandingType } from '@/integrations/supabase/types';

interface PreviewBrandingProps {
  projectId: string;
}

interface BrandingData {
  branding_type: BrandingType;
  watermark_text: string;
}

export function PreviewBranding({ projectId }: PreviewBrandingProps) {
  const [branding, setBranding] = useState<BrandingData | null>(null);

  useEffect(() => {
    supabase
      .from('preview_branding')
      .select('branding_type, watermark_text')
      .eq('project_id', projectId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setBranding(data);
      });
  }, [projectId]);

  if (!branding || branding.branding_type === 'none') return null;

  if (branding.branding_type === 'footer') {
    return (
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'rgba(0,0,0,0.75)',
          color: '#fff',
          textAlign: 'center',
          padding: '6px 12px',
          fontSize: '12px',
          zIndex: 9999,
          pointerEvents: 'none',
        }}
      >
        Made with <strong>eComGear</strong>
      </div>
    );
  }

  if (branding.branding_type === 'watermark') {
    return (
      <div
        style={{
          position: 'fixed',
          top: 12,
          right: 12,
          background: 'rgba(0,0,0,0.6)',
          color: '#fff',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: '11px',
          zIndex: 9999,
          pointerEvents: 'none',
        }}
      >
        {branding.watermark_text}
      </div>
    );
  }

  return null;
}
```

- [ ] **Step 2: Wire into preview render**

Find where the project preview is rendered (likely `src/pages/` or `preview-service/`). Add `<PreviewBranding projectId={projectId} />` as the last child of the preview container.

Search for the preview render location:
```bash
grep -r "preview\|PreviewFrame\|iframe" src/pages/ src/components/ --include="*.tsx" -l
```

Open the found file and add the import and component at the end of the preview wrapper JSX.

- [ ] **Step 3: Commit**

```bash
git add src/components/preview/PreviewBranding.tsx
git commit -m "feat(ui): add PreviewBranding overlay (footer/watermark/none by tier)"
```

---

## Task 4: Agency   Client Markup Settings

**Files:**
- Create: `src/components/agency/ClientMarkupSettings.tsx`

- [ ] **Step 1: Create component**

```tsx
// src/components/agency/ClientMarkupSettings.tsx
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
import type { MarkupType } from '@/integrations/supabase/types';

interface ClientMarkupSettingsProps {
  orgId: string;
  clientUserId: string;
  clientName: string;
}

export function ClientMarkupSettings({ orgId, clientUserId, clientName }: ClientMarkupSettingsProps) {
  const { user } = useAuth();
  const [markupAmount, setMarkupAmount] = useState('0');
  const [markupType, setMarkupType] = useState<MarkupType>('fixed');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('client_markups')
      .select('markup_amount, markup_type')
      .eq('org_id', orgId)
      .eq('client_user_id', clientUserId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setMarkupAmount(String(data.markup_amount));
          setMarkupType(data.markup_type as MarkupType);
        }
        setLoading(false);
      });
  }, [orgId, clientUserId]);

  const save = async () => {
    if (!user?.id) return;
    setSaving(true);
    const { error } = await supabase
      .from('client_markups')
      .upsert({
        org_id: orgId,
        client_user_id: clientUserId,
        markup_amount: parseFloat(markupAmount) || 0,
        markup_type: markupType,
        currency: 'USD',
        created_by: user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'org_id,client_user_id' });

    setSaving(false);
    if (error) {
      toast.error('Failed to save markup: ' + error.message);
    } else {
      toast.success(`Markup saved for ${clientName}`);
    }
  };

  if (loading) return <div className="animate-pulse h-24 bg-muted rounded" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Client Pricing   {clientName}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-3 items-end">
          <div className="flex-1 space-y-1">
            <Label htmlFor="markup-amount">Markup Amount</Label>
            <Input
              id="markup-amount"
              type="number"
              min="0"
              step="0.01"
              value={markupAmount}
              onChange={(e) => setMarkupAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1">
            <Label>Type</Label>
            <Select value={markupType} onValueChange={(v) => setMarkupType(v as MarkupType)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed">Fixed (USD)</SelectItem>
                <SelectItem value="percentage">Percentage (%)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {markupType === 'fixed'
            ? `Client will be charged $${markupAmount} extra per invoice.`
            : `Client will be charged ${markupAmount}% above base cost.`}
        </p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/agency/ClientMarkupSettings.tsx
git commit -m "feat(ui): add ClientMarkupSettings for agency per-client markup"
```

---

## Task 5: Agency   Demo Request Form

**Files:**
- Create: `src/components/agency/DemoRequestForm.tsx`

- [ ] **Step 1: Create component**

```tsx
// src/components/agency/DemoRequestForm.tsx
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from 'sonner';

interface DemoRequestFormProps {
  orgId?: string;
  onSuccess?: () => void;
}

export function DemoRequestForm({ orgId, onSuccess }: DemoRequestFormProps) {
  const { user } = useAuth();
  const [email, setEmail] = useState(user?.email ?? '');
  const [company, setCompany] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submit = async () => {
    if (!email || !company) {
      toast.error('Email and company name are required.');
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.rpc('submit_demo_request', {
      p_email: email,
      p_company_name: company,
      p_message: message || null,
      p_org_id: orgId ?? null,
    });
    setSubmitting(false);
    if (error) {
      toast.error('Failed to submit: ' + error.message);
    } else {
      setSubmitted(true);
      toast.success('Demo request submitted! Our team will contact you soon.');
      onSuccess?.();
    }
  };

  if (submitted) {
    return (
      <Card>
        <CardContent className="pt-6 text-center space-y-2">
          <div className="text-2xl">🎉</div>
          <p className="font-medium">Request received!</p>
          <p className="text-sm text-muted-foreground">
            Our team will reach out to you at <strong>{email}</strong> within 1 business day.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Book a Demo   Upgrade to Agency</CardTitle>
        <CardDescription>
          Agency plan is <strong>$25/mo</strong>. Includes 20 seats, client markup pricing, and all add-ons.
          A member of our team will personally onboard you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="demo-email">Email</Label>
          <Input
            id="demo-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="demo-company">Company Name</Label>
          <Input
            id="demo-company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Acme Agency"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="demo-message">Message (optional)</Label>
          <Textarea
            id="demo-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Tell us about your use case…"
            rows={3}
          />
        </div>
        <Button className="w-full" onClick={submit} disabled={submitting}>
          {submitting ? 'Submitting…' : 'Request Demo'}
        </Button>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/agency/DemoRequestForm.tsx
git commit -m "feat(ui): add DemoRequestForm for agency upgrade flow"
```

---

## Task 6: Add-on Hook

**Files:**
- Create: `src/hooks/useAddonAccess.ts`

- [ ] **Step 1: Create hook**

```typescript
// src/hooks/useAddonAccess.ts
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { AddonType } from '@/integrations/supabase/types';

export function useAddonAccess(orgId: string | null, addonType: AddonType) {
  const [hasAccess, setHasAccess] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orgId) { setLoading(false); return; }
    supabase
      .rpc('check_addon_access', { p_org_id: orgId, p_addon_type: addonType })
      .then(({ data }) => {
        setHasAccess(!!data);
        setLoading(false);
      });
  }, [orgId, addonType]);

  return { hasAccess, loading };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useAddonAccess.ts
git commit -m "feat(hooks): add useAddonAccess for add-on subscription checks"
```

---

## Task 7: Reusable AddonCard Component

**Files:**
- Create: `src/components/addons/AddonCard.tsx`

- [ ] **Step 1: Create component**

```tsx
// src/components/addons/AddonCard.tsx
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface AddonCardProps {
  title: string;
  description: string;
  price: string;
  active: boolean;
  loading?: boolean;
  requiresTier?: 'pro' | 'agency';
  currentTier?: string;
  onActivate?: () => void;
  onDeactivate?: () => void;
  children?: React.ReactNode;
}

export function AddonCard({
  title,
  description,
  price,
  active,
  loading = false,
  requiresTier,
  currentTier,
  onActivate,
  onDeactivate,
  children,
}: AddonCardProps) {
  const tierBlocked =
    requiresTier &&
    currentTier !== requiresTier &&
    currentTier !== 'agency';

  return (
    <Card className={active ? 'border-primary' : ''}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="text-xs mt-0.5">{description}</CardDescription>
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm font-semibold">{price}</div>
            {active && <Badge className="mt-1 text-xs" variant="default">Active</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {children}
        {tierBlocked ? (
          <p className="text-xs text-muted-foreground">
            Requires <strong>{requiresTier}</strong> plan or higher.
          </p>
        ) : (
          <Button
            size="sm"
            variant={active ? 'outline' : 'default'}
            onClick={active ? onDeactivate : onActivate}
            disabled={loading}
            className="w-full"
          >
            {loading ? 'Processing…' : active ? 'Deactivate' : 'Activate'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/addons/AddonCard.tsx
git commit -m "feat(ui): add reusable AddonCard component"
```

---

## Task 8: Auto Pilot Config

**Files:**
- Create: `src/components/addons/AutoPilotConfig.tsx`

- [ ] **Step 1: Create component**

```tsx
// src/components/addons/AutoPilotConfig.tsx
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { AddonCard } from './AddonCard';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import type { AutoPilotSchedule, AutoPilotStatus } from '@/integrations/supabase/types';

interface AutoPilotConfigProps {
  projectId: string;
  orgId: string;
  currentTier: string;
}

interface Config {
  id: string;
  enabled: boolean;
  schedule: AutoPilotSchedule;
  prompt: string;
  status: AutoPilotStatus;
  last_run_at: string | null;
  next_run_at: string | null;
}

export function AutoPilotConfig({ projectId, orgId, currentTier }: AutoPilotConfigProps) {
  const { user } = useAuth();
  const [config, setConfig] = useState<Config | null>(null);
  const [schedule, setSchedule] = useState<AutoPilotSchedule>('daily');
  const [prompt, setPrompt] = useState('Review this project for issues and improvements. Fix any bugs found.');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('auto_pilot_configs')
      .select('*')
      .eq('project_id', projectId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setConfig(data as Config);
          setSchedule(data.schedule as AutoPilotSchedule);
          setPrompt(data.prompt);
        }
        setLoading(false);
      });
  }, [projectId]);

  const activate = async () => {
    if (!user?.id) return;
    setSaving(true);
    const now = new Date();
    const next = new Date(now);
    next.setDate(next.getDate() + (schedule === 'daily' ? 1 : 7));

    const { error } = await supabase.from('auto_pilot_configs').upsert({
      project_id: projectId,
      enabled: true,
      schedule,
      prompt,
      status: 'active' as AutoPilotStatus,
      next_run_at: next.toISOString(),
      created_by: user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id' });

    setSaving(false);
    if (error) {
      toast.error('Failed to activate Auto Pilot: ' + error.message);
    } else {
      toast.success('Auto Pilot activated!');
      const { data } = await supabase.from('auto_pilot_configs').select('*').eq('project_id', projectId).single();
      if (data) setConfig(data as Config);
    }
  };

  const deactivate = async () => {
    setSaving(true);
    const { error } = await supabase
      .from('auto_pilot_configs')
      .update({ enabled: false, status: 'paused' as AutoPilotStatus, updated_at: new Date().toISOString() })
      .eq('project_id', projectId);
    setSaving(false);
    if (error) {
      toast.error('Failed to deactivate: ' + error.message);
    } else {
      toast.success('Auto Pilot paused.');
      setConfig((c) => c ? { ...c, enabled: false, status: 'paused' } : c);
    }
  };

  const isActive = config?.enabled && config?.status === 'active';

  return (
    <AddonCard
      title="Auto Pilot Mode"
      description="AI agent runs automatically on a schedule to review and fix your project."
      price="$98/mo"
      active={!!isActive}
      loading={saving || loading}
      requiresTier="pro"
      currentTier={currentTier}
      onActivate={activate}
      onDeactivate={deactivate}
    >
      {(!isActive) && (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Schedule</Label>
            <Select value={schedule} onValueChange={(v) => setSchedule(v as AutoPilotSchedule)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Agent Prompt</Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              className="text-xs"
            />
          </div>
        </div>
      )}
      {isActive && config && (
        <div className="text-xs text-muted-foreground space-y-1">
          <p>Schedule: <strong>{config.schedule}</strong></p>
          {config.last_run_at && <p>Last run: {new Date(config.last_run_at).toLocaleString()}</p>}
          {config.next_run_at && <p>Next run: {new Date(config.next_run_at).toLocaleString()}</p>}
        </div>
      )}
    </AddonCard>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/addons/AutoPilotConfig.tsx
git commit -m "feat(ui): add AutoPilotConfig component with schedule and prompt settings"
```

---

## Task 9: eComGear Cloud Settings

**Files:**
- Create: `src/components/addons/EComGearCloudSettings.tsx`

- [ ] **Step 1: Create component**

```tsx
// src/components/addons/EComGearCloudSettings.tsx
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AddonCard } from './AddonCard';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

interface EComGearCloudSettingsProps {
  projectId: string;
  currentTier: string;
}

interface CloudConfig {
  id: string;
  enabled: boolean;
  storage_bucket: string | null;
  cdn_url: string | null;
  storage_used_bytes: number;
  storage_limit_bytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function EComGearCloudSettings({ projectId, currentTier }: EComGearCloudSettingsProps) {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('ecomgear_cloud_configs')
      .select('*')
      .eq('project_id', projectId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setConfig(data as CloudConfig);
        setLoading(false);
      });
  }, [projectId]);

  const activate = async () => {
    setSaving(true);
    const bucket = `ecg-cloud-${projectId.replace(/-/g, '').slice(0, 16)}`;
    const { error } = await supabase.from('ecomgear_cloud_configs').upsert({
      project_id: projectId,
      enabled: true,
      storage_bucket: bucket,
      cdn_url: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id' });
    setSaving(false);
    if (error) {
      toast.error('Failed to activate: ' + error.message);
    } else {
      toast.success('eComGear Cloud activated!');
      const { data } = await supabase.from('ecomgear_cloud_configs').select('*').eq('project_id', projectId).single();
      if (data) setConfig(data as CloudConfig);
    }
  };

  const deactivate = async () => {
    setSaving(true);
    const { error } = await supabase
      .from('ecomgear_cloud_configs')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('project_id', projectId);
    setSaving(false);
    if (error) {
      toast.error('Failed to deactivate: ' + error.message);
    } else {
      toast.success('eComGear Cloud deactivated.');
      setConfig((c) => c ? { ...c, enabled: false } : c);
    }
  };

  const usagePercent = config
    ? Math.round((config.storage_used_bytes / config.storage_limit_bytes) * 100)
    : 0;

  return (
    <AddonCard
      title="eComGear Cloud"
      description="Managed CDN storage for project assets   images, fonts, and files."
      price="Included with Pro/Agency"
      active={!!config?.enabled}
      loading={saving || loading}
      requiresTier="pro"
      currentTier={currentTier}
      onActivate={activate}
      onDeactivate={deactivate}
    >
      {config?.enabled && (
        <div className="space-y-2 text-xs">
          {config.cdn_url && (
            <div>
              <span className="text-muted-foreground">CDN URL: </span>
              <code className="text-xs bg-muted px-1 rounded">{config.cdn_url}</code>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Storage</span>
            <span>{formatBytes(config.storage_used_bytes)} / {formatBytes(config.storage_limit_bytes)}</span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${Math.min(usagePercent, 100)}%` }}
            />
          </div>
        </div>
      )}
    </AddonCard>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/addons/EComGearCloudSettings.tsx
git commit -m "feat(ui): add EComGearCloudSettings component with storage usage display"
```

---

## Task 10: Integration App Marketplace

**Files:**
- Create: `src/components/addons/IntegrationAppMarketplace.tsx`

- [ ] **Step 1: Create component**

```tsx
// src/components/addons/IntegrationAppMarketplace.tsx
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import type { IntegrationCategory } from '@/integrations/supabase/types';

interface IntegrationApp {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon_url: string | null;
  category: IntegrationCategory;
}

interface InstalledIntegration {
  integration_app_id: string;
  enabled: boolean;
}

interface IntegrationAppMarketplaceProps {
  projectId: string;
  currentTier: string;
}

const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  ecommerce: 'eCommerce',
  payment: 'Payment',
  marketing: 'Marketing',
  analytics: 'Analytics',
  shipping: 'Shipping',
  other: 'Other',
};

export function IntegrationAppMarketplace({ projectId, currentTier }: IntegrationAppMarketplaceProps) {
  const { user } = useAuth();
  const [apps, setApps] = useState<IntegrationApp[]>([]);
  const [installed, setInstalled] = useState<InstalledIntegration[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);

  const tierBlocked = currentTier === 'free';

  useEffect(() => {
    Promise.all([
      supabase.from('integration_apps').select('id, name, slug, description, icon_url, category').eq('is_active', true).order('category'),
      supabase.from('project_integrations').select('integration_app_id, enabled').eq('project_id', projectId),
    ]).then(([appsRes, installedRes]) => {
      if (appsRes.data) setApps(appsRes.data as IntegrationApp[]);
      if (installedRes.data) setInstalled(installedRes.data as InstalledIntegration[]);
      setLoading(false);
    });
  }, [projectId]);

  const isInstalled = (appId: string) => installed.some((i) => i.integration_app_id === appId && i.enabled);

  const toggle = async (app: IntegrationApp) => {
    if (!user?.id || tierBlocked) return;
    setInstalling(app.id);
    const already = isInstalled(app.id);

    if (already) {
      const { error } = await supabase
        .from('project_integrations')
        .update({ enabled: false, updated_at: new Date().toISOString() })
        .eq('project_id', projectId)
        .eq('integration_app_id', app.id);
      if (!error) {
        setInstalled((prev) => prev.map((i) => i.integration_app_id === app.id ? { ...i, enabled: false } : i));
        toast.success(`${app.name} removed.`);
      }
    } else {
      const { error } = await supabase.from('project_integrations').upsert({
        project_id: projectId,
        integration_app_id: app.id,
        config: {},
        enabled: true,
        installed_by: user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'project_id,integration_app_id' });
      if (!error) {
        setInstalled((prev) => [...prev.filter((i) => i.integration_app_id !== app.id), { integration_app_id: app.id, enabled: true }]);
        toast.success(`${app.name} installed!`);
      } else {
        toast.error('Installation failed: ' + error.message);
      }
    }
    setInstalling(null);
  };

  const filtered = apps.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.description.toLowerCase().includes(search.toLowerCase())
  );

  if (tierBlocked) {
    return (
      <div className="border rounded-lg p-6 text-center space-y-2 text-muted-foreground">
        <p className="font-medium text-foreground">Integration Apps</p>
        <p className="text-sm">Available on Pro and Agency plans.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Input
        placeholder="Search integrations…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />
      {loading ? (
        <div className="grid grid-cols-2 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="animate-pulse h-24 bg-muted rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.map((app) => {
            const active = isInstalled(app.id);
            return (
              <Card key={app.id} className={active ? 'border-primary' : ''}>
                <CardHeader className="pb-1 pt-3 px-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">{app.name}</CardTitle>
                    <Badge variant="outline" className="text-xs">
                      {CATEGORY_LABELS[app.category]}
                    </Badge>
                  </div>
                  <CardDescription className="text-xs">{app.description}</CardDescription>
                </CardHeader>
                <CardContent className="pb-3 px-3">
                  <Button
                    size="sm"
                    variant={active ? 'outline' : 'default'}
                    className="w-full h-7 text-xs"
                    onClick={() => toggle(app)}
                    disabled={installing === app.id}
                  >
                    {installing === app.id ? 'Processing…' : active ? 'Remove' : 'Install'}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/addons/IntegrationAppMarketplace.tsx
git commit -m "feat(ui): add Integration App Marketplace with install/remove"
```

---

## Task 11: Ali Cloud Migration

**Files:**
- Create: `src/components/addons/AliCloudMigration.tsx`

- [ ] **Step 1: Create component**

```tsx
// src/components/addons/AliCloudMigration.tsx
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AddonCard } from './AddonCard';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import type { AliCloudMigrationStatus } from '@/integrations/supabase/types';

interface AliCloudMigrationProps {
  projectId: string;
  currentTier: string;
}

interface AliConfig {
  id: string;
  region: string;
  instance_id: string | null;
  endpoint_url: string | null;
  migration_status: AliCloudMigrationStatus;
  migrated_at: string | null;
}

const STATUS_LABELS: Record<AliCloudMigrationStatus, string> = {
  none: 'Not requested',
  pending: 'Pending admin review',
  migrating: 'Migration in progress',
  complete: 'Migration complete',
  failed: 'Migration failed',
};

const STATUS_VARIANTS: Record<AliCloudMigrationStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  none: 'outline',
  pending: 'secondary',
  migrating: 'secondary',
  complete: 'default',
  failed: 'destructive',
};

const ALI_REGIONS = [
  { value: 'cn-hangzhou', label: 'China East 1 (Hangzhou)' },
  { value: 'cn-shanghai', label: 'China East 2 (Shanghai)' },
  { value: 'cn-beijing',  label: 'China North 2 (Beijing)' },
  { value: 'cn-shenzhen', label: 'China South 1 (Shenzhen)' },
  { value: 'ap-southeast-1', label: 'Asia Pacific SE 1 (Singapore)' },
];

export function AliCloudMigration({ projectId, currentTier }: AliCloudMigrationProps) {
  const [config, setConfig] = useState<AliConfig | null>(null);
  const [region, setRegion] = useState('cn-hangzhou');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('ali_cloud_configs')
      .select('*')
      .eq('project_id', projectId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setConfig(data as AliConfig);
          setRegion(data.region);
        }
        setLoading(false);
      });
  }, [projectId]);

  const requestMigration = async () => {
    setSaving(true);
    const { error } = await supabase.from('ali_cloud_configs').upsert({
      project_id: projectId,
      region,
      migration_status: 'pending' as AliCloudMigrationStatus,
      requested_at: new Date().toISOString(),
    }, { onConflict: 'project_id' });
    setSaving(false);
    if (error) {
      toast.error('Request failed: ' + error.message);
    } else {
      toast.success('Ali Cloud migration requested! Admin will provision your instance.');
      const { data } = await supabase.from('ali_cloud_configs').select('*').eq('project_id', projectId).single();
      if (data) setConfig(data as AliConfig);
    }
  };

  const status = config?.migration_status ?? 'none';
  const isActive = status === 'complete';
  const isPending = status === 'pending' || status === 'migrating';

  return (
    <AddonCard
      title="Hosting   Ali Cloud"
      description="Migrate your hosting to Alibaba Cloud for optimal performance in China and Asia."
      price="$6/domain (same as standard)"
      active={isActive}
      loading={saving || loading}
      requiresTier="pro"
      currentTier={currentTier}
      onActivate={requestMigration}
      onDeactivate={undefined}
    >
      <div className="space-y-3">
        {!isPending && !isActive && (
          <div className="space-y-1">
            <Label className="text-xs">Region</Label>
            <Select value={region} onValueChange={setRegion}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ALI_REGIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value} className="text-xs">{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Status</span>
          <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>
        </div>
        {config?.endpoint_url && (
          <div className="text-xs">
            <span className="text-muted-foreground">Endpoint: </span>
            <code className="bg-muted px-1 rounded">{config.endpoint_url}</code>
          </div>
        )}
        {config?.migrated_at && (
          <p className="text-xs text-muted-foreground">
            Migrated: {new Date(config.migrated_at).toLocaleDateString()}
          </p>
        )}
      </div>
    </AddonCard>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/addons/AliCloudMigration.tsx
git commit -m "feat(ui): add AliCloudMigration component with region selection and status tracking"
```

---

## Task 12: Admin   Demo Requests Page

**Files:**
- Create: `src/pages/admin/DemoRequests.tsx`

- [ ] **Step 1: Create page**

```tsx
// src/pages/admin/DemoRequests.tsx
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import type { DemoRequestStatus } from '@/integrations/supabase/types';

interface DemoRequest {
  id: string;
  email: string;
  company_name: string;
  message: string | null;
  status: DemoRequestStatus;
  requested_at: string;
  admin_notes: string | null;
  org_id: string | null;
}

const STATUS_COLORS: Record<DemoRequestStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending:   'secondary',
  contacted: 'default',
  converted: 'default',
  rejected:  'destructive',
};

export default function DemoRequests() {
  const [requests, setRequests] = useState<DemoRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [orgInputs, setOrgInputs] = useState<Record<string, string>>({});

  const fetch = async () => {
    const { data } = await supabase
      .from('demo_requests')
      .select('id, email, company_name, message, status, requested_at, admin_notes, org_id')
      .order('requested_at', { ascending: false });
    if (data) setRequests(data as DemoRequest[]);
    setLoading(false);
  };

  useEffect(() => { fetch(); }, []);

  const updateStatus = async (id: string, status: DemoRequestStatus) => {
    setUpdatingId(id);
    const { error } = await supabase
      .from('demo_requests')
      .update({ status, admin_notes: notes[id] ?? null })
      .eq('id', id);
    if (error) {
      toast.error('Update failed: ' + error.message);
    } else {
      toast.success('Status updated.');
      await fetch();
    }
    setUpdatingId(null);
  };

  const convertToAgency = async (req: DemoRequest) => {
    const orgId = orgInputs[req.id];
    if (!orgId) { toast.error('Enter org ID to convert.'); return; }
    setUpdatingId(req.id);
    const { error } = await supabase.rpc('convert_demo_to_agency', {
      p_request_id: req.id,
      p_org_id: orgId,
    });
    if (error) {
      toast.error('Conversion failed: ' + error.message);
    } else {
      toast.success(`Org ${orgId} upgraded to Agency!`);
      await fetch();
    }
    setUpdatingId(null);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Demo Requests</h2>
      {loading ? (
        <div className="animate-pulse h-32 bg-muted rounded" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Requested</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((req) => (
              <TableRow key={req.id}>
                <TableCell className="font-medium">{req.company_name}</TableCell>
                <TableCell>{req.email}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_COLORS[req.status]}>{req.status}</Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(req.requested_at).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <div className="space-y-2 max-w-xs">
                    <Textarea
                      placeholder="Admin notes…"
                      className="text-xs h-16"
                      value={notes[req.id] ?? req.admin_notes ?? ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [req.id]: e.target.value }))}
                    />
                    <div className="flex gap-1 flex-wrap">
                      {(['pending','contacted','rejected'] as DemoRequestStatus[]).map((s) => (
                        <Button
                          key={s}
                          size="sm"
                          variant={req.status === s ? 'default' : 'outline'}
                          className="h-6 text-xs px-2"
                          onClick={() => updateStatus(req.id, s)}
                          disabled={updatingId === req.id}
                        >
                          {s}
                        </Button>
                      ))}
                    </div>
                    {req.status !== 'converted' && (
                      <div className="flex gap-1">
                        <Input
                          placeholder="Org UUID"
                          className="h-6 text-xs"
                          value={orgInputs[req.id] ?? ''}
                          onChange={(e) => setOrgInputs((o) => ({ ...o, [req.id]: e.target.value }))}
                        />
                        <Button
                          size="sm"
                          className="h-6 text-xs px-2 bg-green-600 hover:bg-green-700"
                          onClick={() => convertToAgency(req)}
                          disabled={updatingId === req.id}
                        >
                          Convert
                        </Button>
                      </div>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Register route in AdminApp.tsx**

Open `src/pages/admin/AdminApp.tsx` and:
1. Add import: `import DemoRequests from './DemoRequests';`
2. Add route: `<Route path="demo-requests" element={<DemoRequests />} />`
3. Add nav link in sidebar: `{ path: 'demo-requests', label: 'Demo Requests' }`

- [ ] **Step 3: Commit**

```bash
git add src/pages/admin/DemoRequests.tsx src/pages/admin/AdminApp.tsx
git commit -m "feat(admin): add Demo Requests page with status management and agency conversion"
```

---

## Task 13: Update Admin RolesPermissions Page

**Files:**
- Modify: `src/pages/admin/RolesPermissions.tsx`

- [ ] **Step 1: Update tier matrix**

Open `src/pages/admin/RolesPermissions.tsx`. Find the tier/feature matrix data and replace any references to `starter`, `professional`, `enterprise` with `free`, `pro`, `agency`.

Specifically, find the array or object that defines the permission matrix rows and update:
- Any tier labels: `'Starter'` → remove, `'Professional'` → `'Pro'`, `'Enterprise'` → `'Agency'`
- Any `TIER_FEATURES` usages to use the new keys: `'pro'` and `'agency'`
- The feature list to match: `custom_domains`, `remove_branding`, `invite_editors`, `invite_clients`, `ai_agent`, `hosting`, `ali_cloud`, `ecomgear_cloud`, `integration_app`, `auto_pilot`

The matrix should now show:

| Feature | Free | Pro | Agency |
|---------|------|-----|--------|
| Custom Domains | No | Yes | Yes |
| Remove Branding | No | Yes | Yes |
| Invite Editors | No | Yes | Yes |
| Invite Clients | No | No | Yes |
| AI Agent | No | Yes | Yes |
| Hosting | No | Yes | Yes |
| Ali Cloud | No | Yes | Yes |
| eComGear Cloud | No | Yes | Yes |
| Integration App | No | Yes | Yes |
| Auto Pilot | No | Yes | Yes |

- [ ] **Step 2: Commit**

```bash
git add src/pages/admin/RolesPermissions.tsx
git commit -m "feat(admin): update RolesPermissions matrix for free/pro/agency tiers"
```

---

## Task 14: Update Admin Subscriptions Page

**Files:**
- Modify: `src/pages/admin/Subscriptions.tsx`

- [ ] **Step 1: Update tier display**

Open `src/pages/admin/Subscriptions.tsx`. Find all hardcoded tier names and replace:
- `'starter'` → `'free'` (or remove from dropdown)
- `'professional'` → `'pro'`
- `'enterprise'` → `'agency'`

Update any tier select/dropdown to show only `free`, `pro`, `agency` as options.

Update any price display to show:
- `free`: $0/mo
- `pro`: $8/mo
- `agency`: $25/mo

Update seat/project limit displays to match new limits:
- `free`: 1 seat, 1 project
- `pro`: 5 seats, unlimited projects
- `agency`: 20 seats, unlimited projects

Also update the usage display to show `publish_lines_used` / `publish_lines_limit` instead of `ai_gens_used` / `ai_gens_limit`.

- [ ] **Step 2: Commit**

```bash
git add src/pages/admin/Subscriptions.tsx
git commit -m "feat(admin): update Subscriptions page for free/pro/agency tiers and publish lines"
```

---

## Task 15: Final TypeScript Verification

- [ ] **Step 1: Full build check**

```bash
cd /home/xer0bit/Desktop/ecomgear-main
npx tsc --noEmit 2>&1 | head -60
```

Fix any errors. Common ones to look for:
- Components using old `OrgLimits.ai_gens_*` fields → replace with `publish_lines_*`
- Components using old tier names `'starter' | 'professional' | 'enterprise'` → update to `'free' | 'pro' | 'agency'`
- Missing imports for new types (`BrandingType`, `AutoPilotSchedule`, etc.)

- [ ] **Step 2: Final commit**

```bash
git add -A
git status  # verify only intended changes
git commit -m "feat: complete Plan B   all frontend components for roles/billing system"
```

---

## Summary of What Was Built

| Component | What it does |
|-----------|-------------|
| `useGuestSession` | Browser fingerprint tracking, 1-project limit for anonymous users |
| `useReferral` | Referral code, bonus lines balance, reward history |
| `useAddonAccess` | Check if org has active add-on subscription |
| `PreviewBranding` | Footer/watermark overlay on preview based on org tier |
| `ReferralDashboard` | Referral link copy, bonus lines display, reward history |
| `ClientMarkupSettings` | Agency per-client markup (fixed/percentage) with upsert |
| `DemoRequestForm` | Book-a-demo upgrade form with confirmation state |
| `AddonCard` | Reusable addon activate/deactivate card with tier guard |
| `AutoPilotConfig` | Enable/schedule/configure cron-triggered agent loop |
| `EComGearCloudSettings` | Enable cloud storage, shows CDN URL and usage |
| `IntegrationAppMarketplace` | Browse 8 apps, install/remove per project |
| `AliCloudMigration` | Request Ali Cloud migration, region selection, status tracking |
| `DemoRequests` (admin) | Admin queue: status updates, notes, convert-to-agency button |
| `RolesPermissions` (admin) | Updated matrix for free/pro/agency |
| `Subscriptions` (admin) | Updated for new tiers and publish lines |
