import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../integrations/supabase/client';
import { getGenServerUrl } from '../config/external-api';
import ecgLogo from '../assets/ecg-logo.png';

type Phase = 'loading' | 'needs-auth' | 'creating' | 'done' | 'error';
type StepStatus = 'pending' | 'active' | 'done' | 'error';

const STEPS: { id: string; label: string }[] = [
  { id: 'token_exchange', label: 'Verifying launch token' },
  { id: 'project_created', label: 'Creating project' },
  { id: 'template_import', label: 'Importing base dashboard' },
  { id: 'modules_configured', label: 'Configuring modules' },
  { id: 'secrets_stored', label: 'Storing credentials' },
  { id: 'revision_saved', label: 'Saving dashboard files' },
  { id: 'preview_synced', label: 'Syncing live preview' },
];

export default function EcgConnectPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token');

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [stepStatus, setStepStatus] = useState<Record<string, StepStatus>>(
    Object.fromEntries(STEPS.map(s => [s.id, 'pending'])),
  );

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

  function markStep(id: string, status: StepStatus) {
    setStepStatus(prev => {
      const next = { ...prev, [id]: status };
      if (status === 'done') {
        const idx = STEPS.findIndex(s => s.id === id);
        const nextStep = STEPS[idx + 1];
        if (nextStep && next[nextStep.id] === 'pending') next[nextStep.id] = 'active';
      }
      return next;
    });
  }

  async function createProject(accessToken: string) {
    setPhase('creating');
    setStepStatus(prev => ({ ...prev, [STEPS[0].id]: 'active' }));
    try {
      const res = await fetch(getGenServerUrl('/api/v1/ecg-connect'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ token }),
      });

      // Backward/forward compatible: only stream-parse if the server actually
      // sent SSE. A plain JSON response (older server, or an error response
      // sent before SSE headers were set) falls back to the old shape.
      const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream');
      if (!isStream) {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
        setPhase('done');
        navigate(`/project/${data.projectId}`);
        return;
      }

      if (!res.body) throw new Error('No response stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          if (!frame.trim() || frame.startsWith(':')) continue;
          const eventLine = frame.split('\n').find(l => l.startsWith('event:'));
          const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.slice(6).trim();
          const data = JSON.parse(dataLine.slice(5).trim());

          if (event === 'step') {
            markStep(data.id, 'done');
          } else if (event === 'done') {
            setPhase('done');
            navigate(`/project/${data.projectId}`);
            return;
          } else if (event === 'error') {
            setStepStatus(prev => {
              const active = STEPS.find(s => prev[s.id] === 'active');
              return active ? { ...prev, [active.id]: 'error' } : prev;
            });
            setError(data.message ?? 'Failed to create project');
            setPhase('error');
            return;
          }
        }
      }
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
        <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center mx-auto overflow-hidden">
          <img src={ecgLogo} alt="eCG Agents Portal" className="w-8 h-8 object-contain" />
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

        {(phase === 'creating' || phase === 'done') && (
          <ul className="text-left space-y-2.5">
            {STEPS.map(step => {
              const status = stepStatus[step.id];
              return (
                <li key={step.id} className="flex items-center gap-2.5 text-sm">
                  {status === 'done' ? (
                    <span className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                      <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </span>
                  ) : status === 'active' ? (
                    <span className="w-4 h-4 border-2 border-gray-300 border-t-blue-600 rounded-full animate-spin shrink-0" />
                  ) : status === 'error' ? (
                    <span className="w-4 h-4 rounded-full bg-red-500 shrink-0" />
                  ) : (
                    <span className="w-4 h-4 rounded-full border-2 border-gray-200 shrink-0" />
                  )}
                  <span className={status === 'pending' ? 'text-gray-400' : status === 'error' ? 'text-red-600' : 'text-gray-700'}>
                    {step.label}
                  </span>
                </li>
              );
            })}
          </ul>
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
