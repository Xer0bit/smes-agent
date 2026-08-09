import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

export function useAddonAccess(orgId: string | null, addonType: string) {
  const [hasAccess, setHasAccess] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orgId) { setLoading(false); return; }
    supabase
      .rpc('check_addon_access', { p_org_id: orgId, p_addon_type: addonType })
      .then(({ data }) => {
        setHasAccess(!!data);
        setLoading(false);
      });
  }, [orgId, addonType]);

  return { hasAccess, loading };
}
