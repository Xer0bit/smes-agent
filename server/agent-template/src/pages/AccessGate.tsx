import { useEffect, useState } from 'react';
import { ECG } from '../ecg-config';

const STORAGE_KEY = `ecg_access_${ECG.projectId}`;
const SERVER = ECG.proxyUrl.replace(/\/$/, '');

async function requestToken(password?: string): Promise<{ ok: true } | { ok: false; needsPassword: boolean }> {
  const res = await fetch(`${SERVER}/api/v1/ecg-access?projectId=${ECG.projectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(password ? { password } : {}),
  });
  if (res.ok) {
    const { accessToken } = await res.json();
    localStorage.setItem(STORAGE_KEY, accessToken);
    return { ok: true };
  }
  return { ok: false, needsPassword: res.status === 401 };
}

export default function AccessGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'granted' | 'needs-password'>('checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    requestToken()
      .then(r => setStatus(r.ok ? 'granted' : 'needs-password'))
      .catch(() => setStatus('needs-password'));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    const r = await requestToken(password);
    setSubmitting(false);
    if (r.ok) setStatus('granted');
    else setError('Incorrect password');
  }

  if (status === 'granted') return <>{children}</>;

  if (status === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <span className="w-6 h-6 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 max-w-sm w-full space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{ECG.appName}</h1>
          <p className="text-sm text-slate-500 mt-1">This dashboard is password protected.</p>
        </div>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !password}
          className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}
