import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
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

      const { data, error } = await supabase.auth.signInWithPassword({
        email: validatedData.email,
        password: validatedData.password,
      });

      if (error) {
        if (error.message.includes('Invalid login credentials')) {
          throw new Error(t('auth.login.invalidCredentials'));
        }
        throw error;
      }

      if (data.user) {
        toast({
          title: t('auth.login.success'),
          description: t('auth.login.welcomeBack'),
        });

        // Redirect based on role: admins → /admin/dashboard, users → /dashboard
        await navigateByRole(data.user.id, redirectTo);
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

      const provisionWorkspaceFallback = async (userId: string, organizationName: string, projectName: string) => {
        const { data: existingMember } = await supabase
          .from('org_members')
          .select('org_id')
          .eq('user_id', userId)
          .limit(1)
          .maybeSingle();

        // Secondary guard: org may exist without a membership row (partial failure)
        const { data: existingOrg } = existingMember ? { data: null } : await supabase
          .from('organizations')
          .select('id')
          .eq('created_by', userId)
          .limit(1)
          .maybeSingle();

        let organizationId = (existingMember?.org_id ?? existingOrg?.id) as string | undefined;
        if (!organizationId) {
          const slugBase = organizationName
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
          const slug = `${slugBase || 'workspace'}-${Math.random().toString(36).slice(2, 8)}`;

          const { data: org, error: orgError } = await supabase
            .from('organizations')
            .insert({
              name: organizationName,
              slug,
              created_by: userId,
            })
            .select('id')
            .single();

          if (orgError || !org?.id) {
            throw new Error(orgError?.message || 'Failed to create organization');
          }

          organizationId = org.id;
          await supabase.from('org_members').insert({
            org_id: organizationId,
            user_id: userId,
            role: 'admin',
          });
        }

        const { data: existingProject } = await supabase
          .from('projects')
          .select('id')
          .eq('user_id', userId)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();

        if (existingProject?.id) {
          return existingProject.id;
        }

        const { data: project, error: projectError } = await supabase
          .from('projects')
          .insert({
            name: projectName,
            user_id: userId,
            created_by: userId,
            organization_id: organizationId,
          })
          .select('id')
          .single();

        if (projectError || !project?.id) {
          throw new Error(projectError?.message || 'Failed to create project');
        }

        return project.id;
      };

      // Sign up the user
      let { data: authData, error: signUpError } = await supabase.auth.signUp({
        email: validatedData.email,
        password: validatedData.password,
        options: {
          emailRedirectTo: `${window.location.origin}/dashboard`,
          data: {
            full_name: validatedData.fullName,
            organization_name: validatedData.organizationName,
            project_name: validatedData.projectName,
          },
        },
      });

      // Some local Supabase setups reject redirect_to with 422. Retry once without it.
      if (signUpError && (signUpError as any)?.status === 422 && /redirect|redirect_to|not allowed/i.test(signUpError.message || '')) {
        const retry = await supabase.auth.signUp({
          email: validatedData.email,
          password: validatedData.password,
          options: {
            data: {
              full_name: validatedData.fullName,
              organization_name: validatedData.organizationName,
              project_name: validatedData.projectName,
            },
          },
        });
        authData = retry.data;
        signUpError = retry.error;
      }

      if (signUpError) {
        if (signUpError.message.includes('already registered')) {
          throw new Error(t('auth.signup.emailExists'));
        }
        throw signUpError;
      }

      if (authData.user && authData.session) {
        // Track referral if present
        if (referralCode) {
          try {
            await supabase.functions.invoke('track-referral', {
              body: {
                referral_code: referralCode,
                event_type: 'registered',
                user_id: authData.user.id,
              },
            });
          } catch (err) {
            console.error('Failed to track referral:', err);
          }
        }

        // Get guest project ID if coming from guest mode
        const guestProjectKey = 'ecomgear_temp_project';
        const guestData = localStorage.getItem(guestProjectKey);
        let guestProjectId = null;

        if (guestData) {
          try {
            const { projectId } = JSON.parse(guestData);
            guestProjectId = projectId;
            localStorage.removeItem(guestProjectKey);
          } catch (err) {
            console.error('Failed to parse guest data:', err);
          }
        }

        // Call signup-complete edge function to create org and project
        const sessionToken = authData.session?.access_token || (await supabase.auth.getSession()).data.session?.access_token;
        const apikey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '';

        if (!sessionToken) {
          throw new Error('Signup succeeded, but no active session token was found. Please try logging in once.');
        }

        const { data: signupData, error: signupError } = await supabase.functions.invoke('signup-complete', {
          headers: {
            Authorization: `Bearer ${sessionToken}`,
            apikey,
          },
          body: {
            user_id: authData.user.id,
            organization_name: validatedData.organizationName,
            project_name: validatedData.projectName,
            guest_project_id: guestProjectId,
          },
        });

        // Edge function returns { success, organization_id, project_id }
        let project_id = signupData?.project_id;

        if (signupError || !project_id) {
          console.warn('Signup complete edge function failed. Falling back to direct provisioning.', signupError);
          project_id = await provisionWorkspaceFallback(
            authData.user.id,
            validatedData.organizationName,
            validatedData.projectName
          );
        }

        // Send welcome email (fire-and-forget)
        supabase.functions.invoke("welcome", {
          body: {
            email: authData.user.email,
            user_name: validatedData.fullName || validatedData.email.split('@')[0],
            org_name: validatedData.organizationName,
          },
        }).catch(() => {});

        toast({
          title: t('auth.signup.success'),
          description: t('auth.signup.accountCreated'),
        });

        // Navigate to the new project
        navigate(`/project/${project_id}`);
      } else if (authData.user && !authData.session) {
        // Email confirmation required — send our custom confirm email
        supabase.functions.invoke("confirm-email", {
          body: {
            email: authData.user.email,
            user_name: validatedData.fullName || validatedData.email.split('@')[0],
            confirmation_url: `${window.location.origin}/auth/callback`,
          },
        }).catch(() => {});

        toast({
          title: t('auth.signup.checkEmail'),
          description: t('auth.signup.verificationSent'),
        });
      }
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        toast({
          title: t('auth.validationError'),
          description: error.errors[0].message,
          variant: 'destructive',
        });
      } else {
        const message = error?.message || '';
        const isRedirectIssue = /redirect|redirect_to|not allowed/i.test(message);
        toast({
          title: t('auth.signup.error'),
          description: isRedirectIssue
            ? 'Signup redirect URL is not allowed in the current environment. Please contact support or try again.'
            : message,
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
      const resetUrl = `${window.location.origin}/auth/callback`;
      const { error } = await supabase.auth.resetPasswordForEmail(loginEmail.trim(), {
        redirectTo: resetUrl,
      });

      if (error) throw error;

      // Send branded reset email via our edge function (fire-and-forget)
      supabase.functions.invoke("password-reset", {
        body: {
          email: loginEmail.trim(),
          reset_url: resetUrl,
        },
      }).catch(() => {});

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
