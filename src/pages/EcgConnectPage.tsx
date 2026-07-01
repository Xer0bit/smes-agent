import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../integrations/supabase/client';
import { getGenServerUrl } from '../config/external-api';

type Phase = 'loading' | 'needs-auth' | 'creating' | 'done' | 'error';

export default function EcgConnectPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token');

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) { setError('Missing launch token'); setPhase('error'); return; }
    checkAndConnect();
  }, [token]);

  async function checkAndConnect() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setPhase('needs-auth');
      return;
    }
    await createProject(session.access_token);
  }

  async function createProject(accessToken: string) {
    setPhase('creating');
    try {
      const res = await fetch(getGenServerUrl('/api/v1/ecg-connect'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed to create project'); setPhase('error'); return; }
      setPhase('done');
      navigate(`/project/${data.projectId}`);
    } catch (e: any) {
      setError(e.message ?? 'Unexpected error');
      setPhase('error');
    }
  }

  async function handleLogin() {
    const returnUrl = `/ecg-connect?token=${token}`;
    navigate(`/auth?returnTo=${encodeURIComponent(returnUrl)}`);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 max-w-sm w-full text-center space-y-4">
        <div className="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center mx-auto">
          <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <div>
          <h1 className="text-lg font-semibold text-gray-900">eCG Agents Portal</h1>
          <p className="text-sm text-gray-500 mt-1">Connecting your custom dashboard…</p>
        </div>

        {phase === 'loading' && (
          <div className="flex items-center justify-center gap-2 text-gray-500 text-sm">
            <span className="w-4 h-4 border-2 border-gray-300 border-t-blue-600 rounded-full animate-spin inline-block" />
            Checking session…
          </div>
        )}

        {phase === 'needs-auth' && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">Please sign in to eComGear to create your dashboard.</p>
            <button
              onClick={handleLogin}
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              Sign in to eComGear
            </button>
          </div>
        )}

        {phase === 'creating' && (
          <div className="flex items-center justify-center gap-2 text-gray-500 text-sm">
            <span className="w-4 h-4 border-2 border-gray-300 border-t-blue-600 rounded-full animate-spin inline-block" />
            Building your dashboard…
          </div>
        )}

        {phase === 'done' && (
          <p className="text-sm text-green-600">Dashboard ready! Redirecting to editor…</p>
        )}

        {phase === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-red-600">{error}</p>
            <p className="text-xs text-gray-500">
              Launch tokens expire after 30 minutes and can only be used once.
              Return to the eCG Agents Portal and try launching again.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
