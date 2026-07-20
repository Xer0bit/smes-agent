import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { getApiServerUrl } from '@/config/external-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Mail, Lock, User, ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { z } from 'zod';
import logo from '@/assets/ecomgear-auth-logo.png';
import { getOAuthCallbackUrl } from '@/lib/authRedirect';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const signupSchema = z.object({
  fullName: z.string().min(2, 'Name must be at least 2 characters').max(100, 'Name too long'),
  email: z.string().email('Invalid email address').max(255, 'Email too long'),
  password: z.string()
    .min(10, 'Password must be at least 10 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  confirmPassword: z.string(),
  organizationName: z.string().min(2, 'Organization name must be at least 2 characters').max(100, 'Name too long'),
  projectName: z.string().min(2, 'Project name must be at least 2 characters').max(100, 'Name too long'),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

export default function Auth() {
  const [activeTab, setActiveTab] = useState('login');
  const [loading, setLoading] = useState(false);
  const [passwordResetLoading, setPasswordResetLoading] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { toast } = useToast();

  // Get referral code from URL
  const referralCode = searchParams.get('ref');
  const requestedRedirect = searchParams.get('redirect');

  // Get redirect message and URL from navigation state
  const locationState = (window.history.state?.usr || {}) as { message?: string; redirectTo?: string };
  const redirectMessage = locationState.message;
  const stateRedirectTo = locationState.redirectTo;

  const resolveRedirectTarget = (candidate?: string | null) => {
    if (!candidate) return '/dashboard';
    // Only allow in-app relative paths to prevent open redirects.
    if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/dashboard';
    return candidate;
  };

  const redirectTo = resolveRedirectTarget(requestedRedirect || stateRedirectTo);

  // Login form
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);

  // Signup form
  const [signupData, setSignupData] = useState({
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
    organizationName: '',
    projectName: '',
  });
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [showSignupConfirmPassword, setShowSignupConfirmPassword] = useState(false);

  // eCG Auth 2FA flow
  const [pending2faToken, setPending2faToken] = useState<string | null>(null);
  const [twoFaCode, setTwoFaCode] = useState('');
  const [twoFaLoading, setTwoFaLoading] = useState(false);

  // Redirect to the correct panel based on role
  const navigateByRole = async (userId: string, fallback?: string) => {
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .in('role', ['super_admin', 'admin'])
      .maybeSingle();
    if (roleData) {
      navigate('/admin/dashboard');
    } else {
      navigate(fallback || '/dashboard');
    }
  };

  useEffect(() => {
    // Check if already logged in
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) return;

      const { data: { user }, error } = await supabase.auth.getUser();
      if (!error && user) {
        navigateByRole(user.id, redirectTo);
      } else {
        // Stale/invalid session can cause redirect bounce with route guards.
        await supabase.auth.signOut();
      }
    });

    // Set active tab from URL
    const tab = searchParams.get('tab');
    if (tab === 'signup') {
      setActiveTab('signup');
    }

    // Show redirect message if present
    if (redirectMessage) {
      toast({
        title: 'Registration Required',
        description: redirectMessage,
      });
    }
  }, [navigate, searchParams, redirectMessage, redirectTo, toast]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Validate input
      const validatedData = loginSchema.parse({
        email: loginEmail,
        password: loginPassword,
      });

      // Use the backend eCG Auth login endpoint (handles both eCG Auth and legacy Supabase)
      const res = await fetch(getApiServerUrl('/api/v1/auth/ecg/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: validatedData.email,
          password: validatedData.password,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.error === 'invalid_credentials') {
          throw new Error(data.message || t('auth.login.invalidCredentials'));
        }
        throw new Error(data.error || t('auth.login.invalidCredentials'));
      }

      // Check if 2FA is required
      if (data.requires2fa) {
        setPending2faToken(data.pendingToken);
        setLoading(false);
        return;
      }

      if (data.accessToken) {
        localStorage.setItem('ecg-auth-access-token', data.accessToken);
        localStorage.setItem('ecg-auth-user-id', data.user.id);
        localStorage.setItem('ecg-auth-user-email', data.user.email);

        // The eCG Auth tokens ARE real Supabase-issued tokens, but supabase-js
        // doesn't know about them until we hand them over explicitly  
        // RequireAuth (and everything else gating on supabase.auth.getSession())
        // stays "unauthenticated" without this, bouncing straight back to /auth.
        await supabase.auth.setSession({
          access_token: data.accessToken,
          refresh_token: data.refreshToken,
        });
      }

      toast({
        title: t('auth.login.success'),
        description: t('auth.login.welcomeBack'),
      });

      // Redirect based on role: admins → /admin/dashboard, users → /dashboard
      await navigateByRole(data.user.id, redirectTo);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        toast({
          title: t('auth.validationError'),
          description: error.errors[0].message,
          variant: 'destructive',
        });
      } else {
        toast({
          title: t('auth.login.error'),
          description: error.message,
          variant: 'destructive',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Validate input
      const validatedData = signupSchema.parse(signupData);

      // Use the backend eCG Auth register endpoint
      const res = await fetch(getApiServerUrl('/api/v1/auth/ecg/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: validatedData.email,
          password: validatedData.password,
          fullName: validatedData.fullName,
          organizationName: validatedData.organizationName,
          projectName: validatedData.projectName,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Registration failed');
      }

      // Track referral if present
      if (referralCode && data.user?.id) {
        try {
          await supabase.functions.invoke('track-referral', {
            body: {
              referral_code: referralCode,
              event_type: 'registered',
              user_id: data.user.id,
            },
          });
        } catch (err) {
          console.error('Failed to track referral:', err);
        }
      }

      // Handle guest project conversion
      const guestProjectKey = 'ecomgear_temp_project';
      const guestData = localStorage.getItem(guestProjectKey);
      if (guestData) {
        try {
          const parsed = JSON.parse(guestData);
          if (parsed.projectId) {
            // Guest project conversion is handled by the backend already
          }
          localStorage.removeItem(guestProjectKey);
        } catch {
          // ignore parse errors
        }
      }

      if (data.accessToken && data.refreshToken) {
        // Auto-login successful   store tokens
        localStorage.setItem('ecg-auth-access-token', data.accessToken);
        localStorage.setItem('ecg-auth-user-id', data.user.id);
        localStorage.setItem('ecg-auth-user-email', data.user.email);
        await supabase.auth.setSession({
          access_token: data.accessToken,
          refresh_token: data.refreshToken,
        });

        // Send welcome email (fire-and-forget)
        supabase.functions.invoke('welcome', {
          body: {
            email: data.user.email,
            user_name: validatedData.fullName || validatedData.email.split('@')[0],
            org_name: validatedData.organizationName,
          },
        }).catch(() => {});

        toast({
          title: t('auth.signup.success'),
          description: t('auth.signup.accountCreated'),
        });

        navigate(`/project/${data.projectId}`);
      } else {
        // Registration succeeded but auto-login didn't (e.g. 2FA or email confirm required)
        toast({
          title: data.message || t('auth.signup.checkEmail'),
          description: data.projectId ? 'Please log in to continue.' : t('auth.signup.verificationSent'),
        });

        if (data.projectId) {
          setActiveTab('login');
          setLoginEmail(validatedData.email);
        }
      }
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        toast({
          title: t('auth.validationError'),
          description: error.errors[0].message,
          variant: 'destructive',
        });
      } else {
        toast({
          title: t('auth.signup.error'),
          description: error.message,
          variant: 'destructive',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: getOAuthCallbackUrl('/auth/callback'),
          skipBrowserRedirect: false,
        },
      });

      if (error) throw error;
    } catch (error: any) {
      toast({
        title: 'Google Login Failed',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  const handle2faVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pending2faToken || !twoFaCode) return;
    setTwoFaLoading(true);

    try {
      const res = await fetch(getApiServerUrl('/api/v1/auth/ecg/2fa/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken: pending2faToken, code: twoFaCode }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || '2FA verification failed');
      }

      // 2FA succeeded   store tokens and navigate
      localStorage.setItem('ecg-auth-access-token', data.accessToken);
      localStorage.setItem('ecg-auth-user-id', data.user.id);
      localStorage.setItem('ecg-auth-user-email', data.user.email);
      await supabase.auth.setSession({
        access_token: data.accessToken,
        refresh_token: data.refreshToken,
      });
      setPending2faToken(null);
      setTwoFaCode('');

      toast({
        title: t('auth.login.success'),
        description: t('auth.login.welcomeBack'),
      });

      await navigateByRole(data.user.id, redirectTo);
    } catch (error: any) {
      toast({
        title: 'Verification failed',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setTwoFaLoading(false);
    }
  };

  const handle2faResend = async () => {
    if (!pending2faToken) return;
    setTwoFaLoading(true);

    try {
      const res = await fetch(getApiServerUrl('/api/v1/auth/ecg/2fa/resend'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken: pending2faToken }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to resend code');
      }

      toast({
        title: 'Code resent',
        description: 'Check your inbox for the new verification code.',
      });
    } catch (error: any) {
      toast({
        title: 'Failed to resend',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setTwoFaLoading(false);
    }
  };

  const cancel2fa = () => {
    setPending2faToken(null);
    setTwoFaCode('');
  };

  const handleForgotPassword = async () => {
    if (!loginEmail.trim()) {
      toast({
        title: 'Email required',
        description: 'Enter your email first, then click forgot password.',
        variant: 'destructive',
      });
      return;
    }

    setPasswordResetLoading(true);
    try {
      // Use the backend eCG Auth forgot-password endpoint (handles both eCG Auth and legacy)
      const res = await fetch(getApiServerUrl('/api/v1/auth/ecg/forgot-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Password reset failed');
      }

      toast({
        title: 'Reset email sent',
        description: 'Check your inbox for password reset instructions.',
      });
    } catch (error: any) {
      toast({
        title: 'Password reset failed',
        description: error?.message || 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setPasswordResetLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-hero p-4">
      <div className="w-full max-w-md">
        <Button
          variant="ghost"
          onClick={() => navigate('/')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('auth.backToHome')}
        </Button>

        <Card className="border-border/50 shadow-elegant">
          <CardHeader className="space-y-1 text-center">
            <div className="flex justify-center mb-4">
              <img src={logo} alt="eCOMGear logo" className="h-[72px] w-auto object-contain" />
            </div>
            <CardTitle className="text-2xl font-bold bg-gradient-primary bg-clip-text text-transparent">
              {t('auth.welcome')}
            </CardTitle>
            <CardDescription>{t('auth.subtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-2 mb-6">
                <TabsTrigger value="login">{t('auth.login.title')}</TabsTrigger>
                <TabsTrigger value="signup">{t('auth.signup.title')}</TabsTrigger>
              </TabsList>

              <TabsContent value="login">
                {pending2faToken ? (
                  <form onSubmit={handle2faVerify} className="space-y-4">
                    <div className="text-center space-y-2 mb-4">
                      <h3 className="text-lg font-semibold">Two-Factor Authentication</h3>
                      <p className="text-sm text-muted-foreground">
                        Enter the 6-digit code sent to your email.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="twofa-code">Verification Code</Label>
                      <Input
                        id="twofa-code"
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="000000"
                        value={twoFaCode}
                        onChange={(e) => setTwoFaCode(e.target.value.replace(/\D/g, ''))}
                        required
                        disabled={twoFaLoading}
                        autoFocus
                        className="text-center text-2xl tracking-[0.3em] font-mono"
                      />
                    </div>
                    <Button type="submit" className="w-full bg-gradient-primary hover:opacity-90" disabled={twoFaLoading || twoFaCode.length !== 6}>
                      {twoFaLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Verify Code
                    </Button>
                    <div className="flex justify-between">
                      <Button type="button" variant="link" className="h-auto px-0 text-sm" onClick={handle2faResend} disabled={twoFaLoading}>
                        Resend Code
                      </Button>
                      <Button type="button" variant="link" className="h-auto px-0 text-sm" onClick={cancel2fa}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                <form onSubmit={handleLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="login-email">
                      <Mail className="inline h-4 w-4 mr-2" />
                      {t('auth.email')}
                    </Label>
                    <Input
                      id="login-email"
                      type="email"
                      placeholder="you@example.com"
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      required
                      disabled={loading}
                      autoFocus
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="login-password">
                      <Lock className="inline h-4 w-4 mr-2" />
                      {t('auth.password')}
                    </Label>
                    <Input
                      id="login-password"
                      type={showLoginPassword ? 'text' : 'password'}
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      required
                      disabled={loading}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-1 text-xs"
                      onClick={() => setShowLoginPassword((prev) => !prev)}
                    >
                      {showLoginPassword ? <EyeOff className="mr-1 h-3 w-3" /> : <Eye className="mr-1 h-3 w-3" />}
                      {showLoginPassword ? 'Hide password' : 'Show password'}
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto justify-start px-0 text-sm"
                    onClick={handleForgotPassword}
                    disabled={loading || passwordResetLoading}
                  >
                    {passwordResetLoading ? 'Sending reset link...' : 'Forgot password?'}
                  </Button>
                  <Button
                    type="submit"
                    className="w-full bg-gradient-primary hover:opacity-90"
                    disabled={loading}
                  >
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('auth.login.submit')}
                  </Button>
                </form>
                )}
              </TabsContent>

              <TabsContent value="signup">
                <form onSubmit={handleSignup} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="signup-name">
                      <User className="inline h-4 w-4 mr-2" />
                      {t('auth.fullName')}
                    </Label>
                    <Input
                      id="signup-name"
                      type="text"
                      placeholder={t('auth.fullNamePlaceholder')}
                      value={signupData.fullName}
                      onChange={(e) => setSignupData({ ...signupData, fullName: e.target.value })}
                      required
                      disabled={loading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-email">
                      <Mail className="inline h-4 w-4 mr-2" />
                      {t('auth.email')}
                    </Label>
                    <Input
                      id="signup-email"
                      type="email"
                      placeholder="you@example.com"
                      value={signupData.email}
                      onChange={(e) => setSignupData({ ...signupData, email: e.target.value })}
                      required
                      disabled={loading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-org">
                      {t('auth.organizationName')}
                    </Label>
                    <Input
                      id="signup-org"
                      type="text"
                      placeholder={t('auth.organizationPlaceholder')}
                      value={signupData.organizationName}
                      onChange={(e) => setSignupData({ ...signupData, organizationName: e.target.value })}
                      required
                      disabled={loading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-project">
                      {t('auth.projectName')}
                    </Label>
                    <Input
                      id="signup-project"
                      type="text"
                      placeholder={t('auth.projectPlaceholder')}
                      value={signupData.projectName}
                      onChange={(e) => setSignupData({ ...signupData, projectName: e.target.value })}
                      required
                      disabled={loading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-password">
                      <Lock className="inline h-4 w-4 mr-2" />
                      {t('auth.password')}
                    </Label>
                    <Input
                      id="signup-password"
                      type={showSignupPassword ? 'text' : 'password'}
                      value={signupData.password}
                      onChange={(e) => setSignupData({ ...signupData, password: e.target.value })}
                      required
                      disabled={loading}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-1 text-xs"
                      onClick={() => setShowSignupPassword((prev) => !prev)}
                    >
                      {showSignupPassword ? <EyeOff className="mr-1 h-3 w-3" /> : <Eye className="mr-1 h-3 w-3" />}
                      {showSignupPassword ? 'Hide password' : 'Show password'}
                    </Button>
                    <p className="text-xs text-muted-foreground">{t('auth.passwordHint')}</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-confirm">
                      {t('auth.confirmPassword')}
                    </Label>
                    <Input
                      id="signup-confirm"
                      type={showSignupConfirmPassword ? 'text' : 'password'}
                      value={signupData.confirmPassword}
                      onChange={(e) => setSignupData({ ...signupData, confirmPassword: e.target.value })}
                      required
                      disabled={loading}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-1 text-xs"
                      onClick={() => setShowSignupConfirmPassword((prev) => !prev)}
                    >
                      {showSignupConfirmPassword ? <EyeOff className="mr-1 h-3 w-3" /> : <Eye className="mr-1 h-3 w-3" />}
                      {showSignupConfirmPassword ? 'Hide password' : 'Show password'}
                    </Button>
                  </div>
                  <Button
                    type="submit"
                    className="w-full bg-gradient-primary hover:opacity-90"
                    disabled={loading}
                  >
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('auth.signup.submit')}
                  </Button>
                </form>
              </TabsContent>
            </Tabs>

            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">{t('auth.orContinueWith')}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 mb-4">
              <Button
                type="button"
                variant="outline"
                onClick={handleGoogleLogin}
                disabled={loading}
              >
                <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
                Google
              </Button>

            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
