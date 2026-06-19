import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface BrandingData {
  branding_type: 'footer' | 'watermark' | 'none';
  watermark_text: string;
}

interface PreviewBrandingProps {
  projectId: string;
}

export function PreviewBranding({ projectId }: PreviewBrandingProps) {
  const [branding, setBranding] = useState<BrandingData | null>(null);

  useEffect(() => {
    supabase
      .from('preview_branding')
      .select('branding_type, watermark_text')
      .eq('project_id', projectId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setBranding(data as BrandingData);
      });
  }, [projectId]);

  if (!branding || branding.branding_type === 'none') return null;

  if (branding.branding_type === 'footer') {
    return (
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'rgba(0,0,0,0.75)',
          color: '#fff',
          textAlign: 'center',
          padding: '6px 12px',
          fontSize: '12px',
          zIndex: 9999,
          pointerEvents: 'none',
        }}
      >
        Made with <strong>eComGear</strong>
      </div>
    );
  }

  if (branding.branding_type === 'watermark') {
    return (
      <div
        style={{
          position: 'fixed',
          top: 12,
          right: 12,
          background: 'rgba(0,0,0,0.6)',
          color: '#fff',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: '11px',
          zIndex: 9999,
          pointerEvents: 'none',
        }}
      >
        {branding.watermark_text || 'Made with eComGear'}
      </div>
    );
  }

  return null;
}
