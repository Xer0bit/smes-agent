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
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--body-bg)' }}>
        <span className="w-6 h-6 border-2 rounded-full animate-spin"
          style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent)' }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--body-bg)' }}>
      <form onSubmit={handleSubmit} className="rounded-2xl border p-8 max-w-sm w-full space-y-4"
        style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-md)' }}>
        <div className="text-center">
          {ECG.logoUrl ? (
            <img src={ECG.logoUrl} alt="" className="w-11 h-11 mx-auto mb-3 object-contain" style={{ borderRadius: 'var(--radius-sm)' }} />
          ) : (
            <div className="w-11 h-11 mx-auto mb-3 flex items-center justify-center text-white text-lg"
              style={{ background: 'var(--accent)', borderRadius: 'var(--radius-sm)', fontWeight: 'var(--font-weight-heading)' }}>
              {ECG.appName.charAt(0)}
            </div>
          )}
          <h1 className="text-lg" style={{ color: 'var(--text)', fontWeight: 'var(--font-weight-heading)' }}>{ECG.appName}</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>This dashboard is password protected.</p>
        </div>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full text-sm border rounded-lg px-3 py-2.5 focus:outline-none"
          style={{ background: 'var(--body-bg)', borderColor: error ? '#dc2626' : 'var(--border)', color: 'var(--text)' }}
        />
        {error && <p className="text-sm" style={{ color: '#dc2626' }}>{error}</p>}
        <button
          type="submit"
          disabled={submitting || !password}
          className="w-full py-2.5 text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
          style={{ background: 'var(--accent)' }}
        >
          {submitting ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}
