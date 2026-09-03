import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/adminClient';
import { btn, input } from '@/components/admin/ui';

async function hasAdminRole(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .in('role', ['super_admin', 'admin'])
    .single();
  return Boolean(data) && !error;
}

export default function AdminLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    void supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session && (await hasAdminRole(session.user.id))) navigate('/admin/dashboard');
    });
  }, [navigate]);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) throw authError;
      if (!data.user) return;
      if (!(await hasAdminRole(data.user.id))) {
        await supabase.auth.signOut();
        setError('You do not have admin privileges');
        return;
      }
      navigate('/admin/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#0a0b0f] text-[13px]">
      <form onSubmit={handleLogin} className="w-full max-w-xs space-y-3">
        <h1 className="text-sm font-semibold text-white">Admin</h1>
        <input type="email" className={input} placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={loading} />
        <input type="password" className={input} placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={loading} />
        <button type="submit" className={`${btn.primary} w-full`} disabled={loading}>{loading ? 'Signing in' : 'Sign in'}</button>
        {error && <div className="text-red-400">{error}</div>}
      </form>
    </div>
  );
}
