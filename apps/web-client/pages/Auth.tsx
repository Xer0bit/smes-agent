import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { getApiServerUrl } from '@/config/external-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowLeft, Loader2 } from 'lucide-react';
import logo from '@/assets/ecomgear-auth-logo.png';

// Platform login/signup now routes through this app's own server
// (/api/v1/auth/ecg/*), which itself talks to eCG Auth first and falls back
// to legacy Supabase Auth transparently -- see server/src/routes/ecgAuth.routes.ts
// and docs/auth_integration.md. Whatever path succeeds server-side, the
// response is always a real Supabase {accessToken, refreshToken} pair
// (mirrored via authBridge.service.ts when the identity came from eCG Auth),
// so calling supabase.auth.setSession() below is all this page needs to do --
// every other getSession()/onAuthStateChange() call site in the app is
// unaffected. OAuth (Google/GitHub) is unrelated to eCG Auth and still goes
// straight to Supabase.

type Mode = 'login' | 'signup' | '2fa' | 'forgot';

export default function AuthPage() {
  const navigate = useNavigate();
  const [checkingSession, setCheckingSession] = useState(true);
  const [mode, setMode] = useState<Mode>('login');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [pendingToken, setPendingToken] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate('/dashboard', { replace: true });
      } else {
        setCheckingSession(false);
      }
    });
  }, [navigate]);

  const applySession = async (accessToken: string, refreshToken: string) => {
    const { error: sessionErr } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (sessionErr) {
      setError('Signed in, but starting your session failed. Please try again.');
      return;
    }
    navigate('/dashboard', { replace: true });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(getApiServerUrl('/api/v1/auth/ecg/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        setError(data.error || 'Too many attempts. Please wait a few minutes and try again.');
        return;
      }
      if (data.requires2fa) {
        setPendingToken(data.pendingToken);
        setMode('2fa');
        return;
      }
      if (!res.ok) {
        setError(data.message || data.error || 'Invalid login credentials');
        return;
      }
      await applySession(data.accessToken, data.refreshToken);
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify2fa = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(getApiServerUrl('/api/v1/auth/ecg/2fa/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken, code: otpCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Invalid or expired code');
        return;
      }
      await applySession(data.accessToken, data.refreshToken);
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend2fa = async () => {
    if (!pendingToken) return;
    setError(null);
    try {
      const res = await fetch(getApiServerUrl('/api/v1/auth/ecg/2fa/resend'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Could not resend code');
        return;
      }
      setMessage('A new code has been sent.');
    } catch {
      setError('Could not reach the server. Please try again.');
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(getApiServerUrl('/api/v1/auth/ecg/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, fullName, organizationName, projectName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Registration failed');
        return;
      }
      if (data.accessToken) {
        await applySession(data.accessToken, data.refreshToken);
      } else {
        setMessage(data.message || 'Account created. Please log in.');
        setMode('login');
      }
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(getApiServerUrl('/api/v1/auth/ecg/forgot-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      // Always shows the same message regardless of outcome -- anti-enumeration,
      // matches both the legacy flow and eCG Auth's own /auth/password/forgot.
      setMessage(data.message || 'If an account with this email exists, a password reset email has been sent.');
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOAuth = async (provider: 'google' | 'github') => {
    setError(null);
    const { error: oauthErr } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (oauthErr) setError(oauthErr.message);
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-body flex flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <button
          onClick={() => {
            if (mode === 'login' || mode === 'signup') {
              navigate('/');
            } else {
              setMode('login');
              setError(null);
              setMessage(null);
            }
          }}
          className="mb-10 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>

        <div className="mb-8 flex items-center gap-2.5">
          <img src={logo} alt="eComGear" className="h-7 w-auto object-contain" />
        </div>

        <div className="mb-6 space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            {mode === 'login' && 'Sign in'}
            {mode === 'signup' && 'Create an account'}
            {mode === '2fa' && 'Enter your code'}
            {mode === 'forgot' && 'Reset your password'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {mode === 'login' && 'Access your AI IDE workspaces.'}
            {mode === 'signup' && 'Set up your workspace to get started.'}
            {mode === '2fa' && 'Check your email for a 6-digit code.'}
            {mode === 'forgot' && "We'll email you a reset link."}
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {message && (
          <div className="mb-4 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground">
            {message}
          </div>
        )}

        {mode === 'login' && (
          <form onSubmit={handleLogin} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" disabled={submitting} className="w-full h-10">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Sign in'}
            </Button>
            <div className="flex items-center justify-between text-sm pt-1">
              <button type="button" onClick={() => { setMode('forgot'); setError(null); setMessage(null); }} className="text-primary hover:text-primary/80 transition-colors">
                Forgot password?
              </button>
              <button type="button" onClick={() => { setMode('signup'); setError(null); setMessage(null); }} className="text-muted-foreground hover:text-foreground transition-colors">
                Create account
              </button>
            </div>
          </form>
        )}

        {mode === 'signup' && (
          <form onSubmit={handleSignup} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="fullName">Full name</Label>
              <Input id="fullName" required value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="signupEmail">Email</Label>
              <Input id="signupEmail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="signupPassword">Password</Label>
              <Input id="signupPassword" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="organizationName">Organization name</Label>
              <Input id="organizationName" required value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="projectName">First project name</Label>
              <Input id="projectName" required value={projectName} onChange={(e) => setProjectName(e.target.value)} />
            </div>
            <Button type="submit" disabled={submitting} className="w-full h-10">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create account'}
            </Button>
            <div className="text-center text-sm pt-1">
              <button type="button" onClick={() => { setMode('login'); setError(null); setMessage(null); }} className="text-muted-foreground hover:text-foreground transition-colors">
                Already have an account? Sign in
              </button>
            </div>
          </form>
        )}

        {mode === '2fa' && (
          <form onSubmit={handleVerify2fa} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="otp">6-digit code</Label>
              <Input id="otp" required maxLength={6} value={otpCode} onChange={(e) => setOtpCode(e.target.value)} />
            </div>
            <Button type="submit" disabled={submitting} className="w-full h-10">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
            </Button>
            <div className="text-center text-sm pt-1">
              <button type="button" onClick={handleResend2fa} className="text-primary hover:text-primary/80 transition-colors">
                Resend code
              </button>
            </div>
          </form>
        )}

        {mode === 'forgot' && (
          <form onSubmit={handleForgotPassword} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="forgotEmail">Email</Label>
              <Input id="forgotEmail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <Button type="submit" disabled={submitting} className="w-full h-10">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send reset link'}
            </Button>
          </form>
        )}

        {(mode === 'login' || mode === 'signup') && (
          <>
            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or continue with</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Button type="button" variant="outline" onClick={() => handleOAuth('google')} className="h-10">
                Google
              </Button>
              <Button type="button" variant="outline" onClick={() => handleOAuth('github')} className="h-10">
                GitHub
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
