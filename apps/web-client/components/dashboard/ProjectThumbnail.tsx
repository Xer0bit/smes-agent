import { useState, useEffect, useRef } from 'react';
import { ExternalLink, Camera } from 'lucide-react';

interface ProjectThumbnailProps {
  projectName: string;
  thumbnailUrl?: string | null;
  previewUrl: string | null | undefined;
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

// Stable colour derived from project name so each card has a unique accent
function nameToGradient(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  const hue = h % 360;
  return `linear-gradient(135deg, hsl(${hue},60%,18%) 0%, hsl(${(hue + 40) % 360},50%,12%) 100%)`;
}

export function ProjectThumbnail({ projectName, thumbnailUrl, previewUrl }: ProjectThumbnailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [isHovered, setIsHovered] = useState(false);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setIsVisible(true); observer.disconnect(); } },
      { rootMargin: '120px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (isVisible && previewUrl) setLoadState('loading');
    else if (!previewUrl) setLoadState('idle');
  }, [isVisible, previewUrl]);

  // Reset imgError when thumbnailUrl changes (new capture arrived)
  useEffect(() => { setImgError(false); }, [thumbnailUrl]);

  const initials = projectName.charAt(0).toUpperCase();
  const gradient = nameToGradient(projectName);
  const useStoredImage = !!thumbnailUrl && !imgError;
  const showIframe = !useStoredImage && isVisible && previewUrl && loadState !== 'error';

  return (
    <div
      ref={containerRef}
      className="relative h-48 overflow-hidden select-none"
      style={{ background: gradient }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* ── Stored screenshot (fast path) ──────────────────────────── */}
      {useStoredImage ? (
        <img
          src={thumbnailUrl!}
          alt={`Preview of ${projectName}`}
          className="absolute inset-0 w-full h-full object-cover object-top"
          onError={() => setImgError(true)}
        />
      ) : (
        <>
          {/* ── Iframe fallback ─────────────────────────────────────── */}
          {showIframe && (
            <iframe
              src={previewUrl}
              style={{
                position: 'absolute', top: 0, left: 0,
                width: '300%', height: '300%',
                transform: 'scale(0.333)', transformOrigin: 'top left',
                border: 'none', pointerEvents: 'none',
                opacity: loadState === 'loaded' ? 1 : 0,
                transition: 'opacity 0.4s ease',
              }}
              sandbox="allow-scripts allow-same-origin"
              title={`Preview of ${projectName}`}
              onLoad={() => setLoadState('loaded')}
              onError={() => setLoadState('error')}
            />
          )}

          {/* ── Shimmer while iframe loads ───────────────────────────── */}
          {loadState === 'loading' && (
            <div className="absolute inset-0 overflow-hidden">
              <div className="absolute inset-0 animate-pulse bg-white/5" />
              <div
                className="absolute inset-0 -translate-x-full animate-[shimmer_1.8s_infinite]"
                style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.06) 50%, transparent 100%)' }}
              />
            </div>
          )}

          {/* ── Placeholder when no preview and no iframe loaded ────── */}
          {(loadState === 'idle' || loadState === 'error') && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <span className="text-5xl font-bold text-white/20 leading-none">{initials}</span>
              <div className="flex items-center gap-1.5 text-white/25 text-xs">
                <Camera className="h-3.5 w-3.5" />
                <span>No preview yet</span>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Subtle bottom gradient ───────────────────────────────────── */}
      <div className="absolute bottom-0 inset-x-0 h-12 bg-gradient-to-t from-black/40 to-transparent pointer-events-none" />

      {/* ── Hover overlay ────────────────────────────────────────────── */}
      {isHovered && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center gap-2 backdrop-blur-[1px] transition-all">
          {previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1.5 bg-white/15 backdrop-blur-sm text-white text-xs font-medium px-3 py-1.5 rounded-lg border border-white/25 hover:bg-white/25 transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open Preview
            </a>
          )}
        </div>
      )}
    </div>
  );
}
