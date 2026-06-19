import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

const GUEST_FP_KEY = 'ecg_guest_fp';
const GUEST_REQUESTS_KEY = 'ecg_guest_requests';
const GUEST_MAX_REQUESTS = 3;

function getBrowserFingerprint(): string {
  let fp = localStorage.getItem(GUEST_FP_KEY);
  if (!fp) {
    fp = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(GUEST_FP_KEY, fp);
  }
  return fp;
}

export function useGuestSession() {
  const [canCreate, setCanCreate] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestsUsed, setRequestsUsed] = useState(0);
  const [requestsLimit, setRequestsLimit] = useState(GUEST_MAX_REQUESTS);

  const canRequest = requestsUsed < requestsLimit;
  const requestsRemaining = Math.max(0, requestsLimit - requestsUsed);

  useEffect(() => {
    const fingerprint = getBrowserFingerprint();

    // Load guest request count from localStorage (fast) then sync from DB
    const cached = parseInt(localStorage.getItem(GUEST_REQUESTS_KEY) || '0', 10);
    setRequestsUsed(cached);

    // Fetch projects_created for canCreate check (direct read is fine here)
    supabase
      .from('guest_sessions')
      .select('projects_created')
      .eq('fingerprint', fingerprint)
      .maybeSingle()
      .then(({ data }) => {
        setCanCreate(!data || (data.projects_created ?? 0) < 1);
      });

    // Use RPC for AI request count so daily reset logic is applied on page load
    supabase
      .rpc('get_guest_ai_requests', { p_fingerprint: fingerprint })
      .then(({ data }) => {
        if (data) {
          const result = data as { requests_used: number; requests_limit: number; can_request: boolean };
          setRequestsUsed(result.requests_used);
          setRequestsLimit(result.requests_limit);
          localStorage.setItem(GUEST_REQUESTS_KEY, String(result.requests_used));
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  /** Check without side-effects whether this guest can still create a project. */
  const checkCanCreate = useCallback(async (): Promise<boolean> => {
    const fingerprint = getBrowserFingerprint();
    const { data } = await supabase
      .from('guest_sessions')
      .select('projects_created')
      .eq('fingerprint', fingerprint)
      .maybeSingle();
    return !data || (data.projects_created ?? 0) < 1;
  }, []);

  /** Record that a guest project was created (increments counter). Returns false on limit exceeded. */
  const recordGuestProject = useCallback(async (): Promise<boolean> => {
    const fingerprint = getBrowserFingerprint();
    const { data, error } = await supabase.rpc('check_and_increment_guest_project', {
      p_fingerprint: fingerprint,
    });
    if (error) return false;
    return data as boolean;
  }, []);

  /** Record that a guest AI request was made. Updates local state optimistically. */
  const recordGuestAIRequest = useCallback(() => {
    setRequestsUsed(prev => {
      const next = prev + 1;
      localStorage.setItem(GUEST_REQUESTS_KEY, String(next));
      return next;
    });
  }, []);

  /** Get the fingerprint for passing to the backend. */
  const getFingerprint = useCallback(() => getBrowserFingerprint(), []);

  /** Refresh request count from the database. */
  const refreshRequestCount = useCallback(async () => {
    const fingerprint = getBrowserFingerprint();
    const { data } = await supabase
      .rpc('get_guest_ai_requests', { p_fingerprint: fingerprint })
      .catch(() => ({ data: null }));
    if (data) {
      const result = data as { requests_used: number; requests_limit: number; can_request: boolean };
      setRequestsUsed(result.requests_used);
      setRequestsLimit(result.requests_limit);
      localStorage.setItem(GUEST_REQUESTS_KEY, String(result.requests_used));
    }
  }, []);

  return {
    canCreate,
    loading,
    checkCanCreate,
    recordGuestProject,
    // AI request tracking
    requestsUsed,
    requestsLimit,
    requestsRemaining,
    canRequest,
    recordGuestAIRequest,
    getFingerprint,
    refreshRequestCount,
  };
}
