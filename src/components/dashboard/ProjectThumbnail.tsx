import { useState, useEffect, useRef } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

interface ProjectThumbnailProps {
  projectName: string;
  previewUrl: string | null | undefined;
  /** Called when user clicks the refresh icon to request a URL re-fetch from the parent */
  onRefresh?: () => void;
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * Renders a scaled-down iframe thumbnail for a project preview.
 *
 * - Only mounts the iframe once the card scrolls into the viewport
 *   (IntersectionObserver with 100 px rootMargin for early load).
 * - Shows a skeleton while the iframe is loading.
 * - Falls back to an initial-letter tile when there is no preview URL
 *   or when the iframe fails to load.
 * - Shows an "Open Preview" overlay on hover.
 */
export function ProjectThumbnail({ projectName, previewUrl, onRefresh }: ProjectThumbnailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [isHovered, setIsHovered] = useState(false);

  // Watch when the card enters the viewport before mounting the iframe
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '100px' }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Transition to 'loading' as soon as we have a URL and the card is visible
  useEffect(() => {
    if (isVisible && previewUrl) {
      setLoadState('loading');
    } else if (!previewUrl) {
      setLoadState('idle');
    }
  }, [isVisible, previewUrl]);

  const initials = projectName.charAt(0).toUpperCase();
  const showIframe = isVisible && previewUrl && loadState !== 'error';

  return (
    <div
      ref={containerRef}
      className="relative h-40 overflow-hidden bg-muted/30 select-none"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* ── Fallback / skeleton layer ─────────────────────────── */}
      {loadState !== 'loaded' && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-primary/10 to-primary/5">
          {loadState === 'loading' ? (
            <Skeleton className="absolute inset-0 rounded-none bg-muted/60" />
          ) : (
            <span className="text-4xl font-bold text-primary/20">{initials}</span>
          )}
        </div>
      )}

      {/* ── Iframe ────────────────────────────────────────────── */}
      {showIframe && (
        <iframe
          src={previewUrl}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '300%',
            height: '300%',
            transform: 'scale(0.333)',
            transformOrigin: 'top left',
            border: 'none',
            pointerEvents: 'none',
            opacity: loadState === 'loaded' ? 1 : 0,
            transition: 'opacity 0.3s ease',
          }}
          sandbox="allow-scripts allow-same-origin"
          title={`Preview of ${projectName}`}
          onLoad={() => setLoadState('loaded')}
          onError={() => setLoadState('error')}
        />
      )}

      {/* ── Error label (shown over the fallback tile) ─────────── */}
      {loadState === 'error' && (
        <div className="absolute bottom-2 left-0 right-0 flex justify-center">
          <span className="text-[10px] text-muted-foreground bg-background/80 px-2 py-0.5 rounded-full">
            Preview unavailable
          </span>
        </div>
      )}

      {/* ── Hover overlay ─────────────────────────────────────── */}
      {isHovered && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center gap-2 transition-opacity">
          {previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1.5 bg-white/10 backdrop-blur-sm text-white text-xs font-medium px-3 py-1.5 rounded-lg border border-white/20 hover:bg-white/20 transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open Preview
            </a>
          )}
          {onRefresh && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setLoadState('idle');
                onRefresh();
              }}
              className="flex items-center gap-1.5 bg-white/10 backdrop-blur-sm text-white text-xs font-medium px-3 py-1.5 rounded-lg border border-white/20 hover:bg-white/20 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          )}
        </div>
      )}
    </div>
  );
}
