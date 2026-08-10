import { useEffect, useState } from 'react';
import { getFileDataUrl } from '@/lib/tenant';

/** Resolves a stored file id (app_files.id) to a displayable data: URL. */
export function useFileUrl(fileId: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!fileId) { setUrl(null); return; }
    let cancelled = false;
    getFileDataUrl(fileId).then((u) => { if (!cancelled) setUrl(u); }).catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
  }, [fileId]);

  return url;
}

/** <img> that resolves a stored file id before rendering. */
export function StoredImage({ fileId, alt, className }: { fileId: string | null | undefined; alt: string; className?: string }) {
  const url = useFileUrl(fileId);
  if (!url) return <div className={className} aria-label={`${alt} loading`} />;
  return <img src={url} alt={alt} className={className} />;
}
