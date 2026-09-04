import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/adminClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Lock } from 'lucide-react';
import logo from '@/assets/logo/svg/smes-agent-icon.svg';

export default function AdminLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) checkAdminRole(session.user.id);
    });
  }, []);

  const checkAdminRole = async (userId: string) => {
    const { data, error } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .in('role', ['super_admin', 'admin'])
      .single();
    if (data && !error) navigate('/admin/dashboard');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      if (data.user) {
        const { data: roleData, error: roleError } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', data.user.id)
          .in('role', ['super_admin', 'admin'])
          .single();

        if (roleError || !roleData) {
          await supabase.auth.signOut();
          toast({ title: 'Access Denied', description: 'You do not have admin privileges', variant: 'destructive' });
          return;
        }
        navigate('/admin/dashboard');
      }
    } catch (error: any) {
      toast({ title: 'Login Failed', description: error.message || 'Invalid credentials', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div
        className="relative w-full max-w-sm rounded-none border border-border bg-card p-8"
      >
        <div className="flex flex-col items-center mb-8">
          <img src={logo} alt="SMEsAgent" className="h-10 w-auto mb-4" />
          <h1 className="text-xl font-bold text-white">Admin Panel</h1>
          <p className="text-xs text-muted-foreground mt-1">Sign in to manage your platform</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Email</Label>
            <Input
              type="email"
              placeholder="admin@SMEsAgent.dev"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
              className="h-10 bg-white/5 border-white/10 text-white placeholder:text-muted-foreground/60 focus:border-primary/50 focus:ring-primary/20"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
              className="h-10 bg-white/5 border-white/10 text-white placeholder:text-muted-foreground/60 focus:border-primary/50 focus:ring-primary/20"
            />
          </div>
          <Button
            type="submit"
            disabled={loading}
            className="w-full h-10 text-sm font-medium text-white gap-2"
            style={{ background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)' }}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
            Sign In
          </Button>
        </form>
      </div>
    </div>
  );
}
