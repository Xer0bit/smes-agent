/**
 * Multi-Device Preview
 * Shows preview in desktop, tablet, or mobile frame with realistic dimensions.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Monitor, Tablet, Smartphone, ExternalLink, RotateCcw, Wrench, AlertTriangle, MousePointerClick } from 'lucide-react';

const PREVIEW_SERVICE_URL =
  (import.meta.env.VITE_PREVIEW_SERVICE_URL as string | undefined) || 'http://localhost:3001';

/** Minimal shape returned by /preview/:id/status */
interface PreviewStatus {
  healthy: boolean;
  errors?: string[];
    diagnosticKind?: 'healthy' | 'validation' | 'runtime' | 'build' | 'service';
    updatedAt?: string | null;
    stalePreviewRetained?: boolean;
}

type DeviceMode = 'desktop' | 'tablet' | 'mobile';

interface DeviceConfig {
    width: string;
    height: string;
    label: string;
    icon: React.ReactNode;
}

const DEVICE_CONFIGS: Record<DeviceMode, DeviceConfig> = {
    desktop: {
        width: '100%',
        height: '100%',
        label: 'Desktop',
        icon: <Monitor className="w-4 h-4" />,
    },
    tablet: {
        width: '768px',
        height: '100%',
        label: 'Tablet',
        icon: <Tablet className="w-4 h-4" />,
    },
    mobile: {
        width: '375px',
        height: '100%',
        label: 'Mobile',
        icon: <Smartphone className="w-4 h-4" />,
    },
};

interface MultiDevicePreviewProps {
    src?: string | null;
    htmlContent?: string | null;
    viewMode: DeviceMode;
    onViewModeChange: (mode: DeviceMode) => void;
    onRefresh?: () => void;
    onOpenExternal?: () => void;
    onRepair?: (errorSummary: string) => void;
    /** Fired once when the preview iframe fires its first load event. */
    onPreviewFirstPaint?: () => void;
    status?: 'pending' | 'building' | 'ready' | 'failed';
    currentPath?: string;
    projectId?: string;
    /** Inspect mode toggle   when true, clicking elements in the preview posts a selector back. */
    inspectMode?: boolean;
    onInspectModeChange?: (active: boolean) => void;
}

function isNonFatalAssetError(errorText: string): boolean {
    const text = errorText.toLowerCase();
    // [object Event] is a stringified Event object   this happens when a resource (image, font, etc.)
    // fails to load. The window error listener catches it but it's not a JS/build error.
    if (text.includes('[object event]')) return true;
    const hasAssetExt = /(\.png|\.jpe?g|\.gif|\.webp|\.svg|\.ico|\.avif|\.woff2?|\.ttf|\.otf)/.test(text);
    const hasMissingSignal = text.includes('404') || text.includes('not found') || text.includes('failed to load') || text.includes('net::err');

    return hasAssetExt && hasMissingSignal;
}

/** Extract the first affected file path from a Vite/PostCSS error string */
function extractFilePath(errorText: string): string | null {
    const m = errorText.match(/(?:projects\/[^/]+\/[^/]+\/|\/src\/)([\w/.-]+\.\w+)/);
    return m ? m[1] : null;
}


function getBlockingStateCopy(_previewStatus: PreviewStatus): { title: string; description: string } {
    return {
        title: 'Something needs fixing',
        description: 'We detected an issue with the latest update. Click Repair to auto-fix it.',
    };
}

export const MultiDevicePreview: React.FC<MultiDevicePreviewProps> = ({
    src,
    htmlContent,
    viewMode,
    onViewModeChange,
    onRefresh,
    onOpenExternal,
    onRepair,
    onPreviewFirstPaint,
    status = 'pending',
    currentPath,
    projectId,
    inspectMode = false,
    onInspectModeChange,
}) => {
    const config = DEVICE_CONFIGS[viewMode];
    const [previewDiagnostics, setPreviewDiagnostics] = useState<PreviewStatus>({ healthy: true, errors: [], diagnosticKind: 'healthy' });
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [blankScreen, setBlankScreen] = useState(false);
    const blankTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const iframeRef = useRef<HTMLIFrameElement>(null);

    // Toggle inspect mode in the iframe via postMessage whenever the prop changes
    useEffect(() => {
        const iframe = iframeRef.current;
        if (iframe?.contentWindow) {
            iframe.contentWindow.postMessage({ type: 'ecg-inspect-mode', active: inspectMode }, '*');
        }
    }, [inspectMode, src]);

    // Poll preview service for build errors once a preview URL is loaded.
    // Skips the request while the tab is backgrounded (document.hidden)   this
    // was firing every 4s indefinitely even when nobody was looking at the tab.
    useEffect(() => {
        if (!projectId || !src) return;

        const poll = async () => {
            if (document.hidden) return;
            try {
                const res = await fetch(`${PREVIEW_SERVICE_URL}/preview/${projectId}/status`, {
                    signal: AbortSignal.timeout(5000),
                });
                if (!res.ok) return;
                const data: PreviewStatus = await res.json();
                setPreviewDiagnostics({
                    healthy: Boolean(data.healthy),
                    errors: data.errors ?? [],
                    diagnosticKind: data.diagnosticKind ?? (data.healthy ? 'healthy' : 'build'),
                    updatedAt: data.updatedAt ?? null,
                    stalePreviewRetained: data.stalePreviewRetained,
                });
            } catch {
                // network error   ignore silently
            }
        };

        // Initial check immediately, then every 4 s while the tab is visible.
        // Also re-check the moment the tab comes back into focus.
        poll();
        pollRef.current = setInterval(poll, 4000);
        document.addEventListener('visibilitychange', poll);
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
            document.removeEventListener('visibilitychange', poll);
        };
    }, [projectId, src]);

    // Reset blank-screen flag whenever URL/content changes
    useEffect(() => {
        setBlankScreen(false);
        if (blankTimerRef.current) clearTimeout(blankTimerRef.current);
    }, [src, htmlContent]);

    const handleIframeLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
        // Notify parent that the preview iframe has rendered (for loading UI).
        onPreviewFirstPaint?.();
        // After the iframe loads, wait 3 s then check if the body has any rendered content.
        // A truly blank white screen will have an empty (or near-empty) body.
        if (blankTimerRef.current) clearTimeout(blankTimerRef.current);
        blankTimerRef.current = setTimeout(() => {
            try {
                const iframe = e.currentTarget;
                const body = iframe.contentDocument?.body;
                if (body && body.children.length === 0 && (body.innerText || '').trim() === '') {
                    setBlankScreen(true);
                    // Immediately force a status poll to check for errors
                    if (projectId) {
                        fetch(`${PREVIEW_SERVICE_URL}/preview/${projectId}/status`, {
                            signal: AbortSignal.timeout(5000),
                        })
                            .then(r => r.json())
                            .then((data: PreviewStatus) => {
                                setPreviewDiagnostics({
                                    healthy: Boolean(data.healthy),
                                    errors: data.errors ?? [],
                                    diagnosticKind: data.diagnosticKind ?? (data.healthy ? 'healthy' : 'build'),
                                    updatedAt: data.updatedAt ?? null,
                                    stalePreviewRetained: data.stalePreviewRetained,
                                });
                            })
                            .catch(() => {});
                    }
                }
            } catch {
                // cross-origin iframe   can't inspect, ignore
            }
        }, 3000);
    };

    const buildErrors = previewDiagnostics.errors ?? [];
    const fatalBuildErrors = buildErrors.filter((err) => !isNonFatalAssetError(err));
    const hasBuildErrors = fatalBuildErrors.length > 0;

    const hasRenderableFrame = Boolean(src || htmlContent);
    const blockingCopy = getBlockingStateCopy(previewDiagnostics);

    const handleRepair = () => {
        if (!onRepair) return;
        // Build a structured repair prompt from the actual diagnostics instead
        // of a generic "fix the build error"   the agent gets the real error
        // text, the diagnostic kind, and the file path, so it can fix it in
        // one shot instead of guessing.
        const allErrors = [...fatalBuildErrors, ...buildErrors].filter(Boolean);
        const firstError = allErrors[0] ?? '';
        const file = extractFilePath(firstError);
        const kind = previewDiagnostics.diagnosticKind ?? 'build';

        const errorText = allErrors.slice(0, 3).join('\n').slice(0, 1500);
        const parts: string[] = [];
        if (kind === 'runtime') {
            parts.push('The preview is showing a blank screen due to a runtime error.');
        } else if (kind === 'validation') {
            parts.push('The preview failed a source validation check.');
        } else {
            parts.push('The preview has a build error.');
        }
        if (file) parts.push(`The error is in ${file}.`);
        if (errorText) {
            parts.push(`Here is the actual error output:\n\n${errorText}`);
        }
        parts.push('Fix the root cause so the app renders correctly.');
        onRepair(parts.join(' '));
    };

    const renderContent = () => {
        if (status === 'building' && !hasRenderableFrame) {
            return (
                <div className="flex items-center justify-center h-full bg-gray-900">
                    <div className="text-center">
                        <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full mx-auto" />
                    </div>
                </div>
            );
        }

        // If there is no renderable frame yet, show blocking error states.
        if (hasBuildErrors && !hasRenderableFrame) {
            return (
                <div className="flex items-center justify-center h-full bg-gray-900">
                    <div className="text-center max-w-sm px-6">
                        <div className="flex justify-center mb-3">
                            <AlertTriangle className="w-10 h-10 text-amber-400" />
                        </div>
                        <p className="text-white font-semibold text-sm mb-1">{blockingCopy.title}</p>
                        <p className="text-gray-400 text-xs mb-4">
                            {blockingCopy.description}
                        </p>
                                        <div className="flex gap-2 justify-center">
                            {onRepair && (
                                <Button size="sm" onClick={handleRepair} className="bg-indigo-600 hover:bg-indigo-500 text-white gap-1.5">
                                    <Wrench className="w-3.5 h-3.5" />
                                    Repair
                                </Button>
                            )}
                            {onRefresh && (
                                <Button variant="outline" size="sm" onClick={onRefresh} className="gap-1.5">
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    Retry
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            );
        }

        if (status === 'failed' && !hasRenderableFrame) {
            return (
                <div className="flex items-center justify-center h-full bg-gray-900">
                    <div className="text-center max-w-sm px-6">
                        <div className="flex justify-center mb-3">
                            <AlertTriangle className="w-10 h-10 text-amber-400" />
                        </div>
                        <p className="text-white font-semibold text-sm mb-1">Something needs fixing</p>
                        <p className="text-gray-400 text-xs mb-4">We detected an issue. Click Repair to auto-fix it.</p>
                        <div className="flex gap-2 justify-center">
                            {onRepair && (
                                <Button size="sm" onClick={handleRepair} className="bg-indigo-600 hover:bg-indigo-500 text-white gap-1.5">
                                    <Wrench className="w-3.5 h-3.5" />
                                    Repair
                                </Button>
                            )}
                            {onRefresh && (
                                <Button variant="outline" size="sm" onClick={onRefresh} className="gap-1.5">
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    Retry
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            );
        }

        // Prioritize external URL (Docker) over local srcDoc to avoid relative path issues
        if (src) {
            return (
                <div className="relative w-full h-full">
                    <iframe
                        ref={iframeRef}
                        src={src}
                        title="Preview"
                        className="w-full h-full border-0 bg-white"
                        onLoad={handleIframeLoad}
                    />
                    {blankScreen && !hasBuildErrors && (
                        <div className="absolute inset-0 flex items-center justify-center bg-gray-900 z-10">
                            <div className="text-center max-w-sm px-6">
                                <div className="flex justify-center mb-3">
                                    <AlertTriangle className="w-10 h-10 text-amber-400" />
                                </div>
                                <p className="text-white font-semibold text-sm mb-1">App rendered nothing</p>
                                <p className="text-gray-400 text-xs mb-4">
                                    The app loaded but the screen is blank. There may be a runtime error   try refreshing or repairing.
                                </p>
                                <div className="flex gap-2 justify-center">
                                    {onRepair && (
                                        <Button size="sm" onClick={() => onRepair('The preview shows a blank screen. Find and fix the runtime error that prevents the app from rendering.')} className="bg-indigo-600 hover:bg-indigo-500 text-white gap-1.5">
                                            <Wrench className="w-3.5 h-3.5" />
                                            Repair
                                        </Button>
                                    )}
                                    {onRefresh && (
                                        <Button variant="outline" size="sm" onClick={() => { setBlankScreen(false); onRefresh(); }} className="gap-1.5">
                                            <RotateCcw className="w-3.5 h-3.5" />
                                            Retry
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            );
        }

        if (htmlContent) {
            return (
                <div className="relative w-full h-full">
                    <iframe
                        srcDoc={htmlContent}
                        title="Preview"
                        className="w-full h-full border-0 bg-white"
                        sandbox="allow-scripts allow-same-origin"
                    />
                </div>
            );
        }

        return (
            <div className="relative flex h-full items-center justify-center overflow-hidden bg-gray-900">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(99,102,241,0.18),transparent_35%),radial-gradient(circle_at_bottom,rgba(168,85,247,0.14),transparent_30%)]" />
                <div className="relative z-10 flex w-full max-w-lg flex-col items-center px-6">
                    <video
                        src="/assets/loading.mp4"
                        autoPlay
                        loop
                        muted
                        playsInline
                        className="w-full border border-white/10 object-cover shadow-[0_24px_80px_rgba(3,12,27,0.4)]"
                    />
                </div>
            </div>
        );
    };

    return (
        <div className="flex flex-col h-full">
            {/* Inspect mode toggle now lives in Editor's main toolbar (next to the
                source-code-view button) instead of its own bar here   a second
                strip stacked right under that toolbar was visually redundant. */}
            {inspectMode && (
                <div className="flex items-center justify-center px-2 py-1 bg-indigo-500/10 border-b border-indigo-500/20">
                    <span className="flex items-center gap-1.5 text-[11px] text-indigo-300">
                        <MousePointerClick className="w-3 h-3" />
                        Click an element in the preview to inspect it
                    </span>
                </div>
            )}

            {/* Preview Container */}
            <div className="flex-1 bg-gray-900/50 flex items-center justify-center p-1 overflow-hidden">
                <div
                    className="bg-white shadow-2xl rounded-lg overflow-hidden ring-1 ring-white/10 transition-all duration-300"
                    style={{
                        width: config.width,
                        height: config.height,
                        maxWidth: '100%',
                        maxHeight: '100%',
                    }}
                >
                    {renderContent()}
                </div>
            </div>

            {/* Status Bar */}
            <div className="flex items-center justify-between px-4 py-1.5 bg-gray-800/50 border-t border-white/5 text-xs text-gray-500">
                <span>{config.label} - {viewMode === 'desktop' ? 'Full width' : config.width}</span>
                <span className={`flex items-center gap-1.5 ${
                    status === 'ready' ? 'text-green-400' :
                    status === 'building' ? 'text-yellow-400' :
                    status === 'failed' || hasBuildErrors ? 'text-amber-400' : 'text-gray-500'
                    }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                        status === 'ready' ? 'bg-green-400' :
                        status === 'building' ? 'bg-yellow-400 animate-pulse' :
                        status === 'failed' || hasBuildErrors ? 'bg-amber-400 animate-pulse' : 'bg-gray-500'
                        }`} />
                    {status === 'building' ? 'Building' :
                     status === 'ready' ? 'Ready' :
                     status === 'failed' || hasBuildErrors ? 'Needs Repair' : 'Idle'}
                </span>
            </div>
        </div>
    );
};

export default MultiDevicePreview;
