/**
 * Multi-Device Preview
 * Shows preview in desktop, tablet, or mobile frame with realistic dimensions.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { PreviewPlaceholder, type RunProgress } from '@/components/PreviewPlaceholder';
import { Monitor, Tablet, Smartphone, ExternalLink, RotateCcw, Wrench, AlertTriangle, MousePointerClick } from 'lucide-react';

const PREVIEW_SERVICE_URL =
  (import.meta.env.VITE_PREVIEW_SERVICE_URL as string | undefined) || 'http://localhost:3001';

/** Minimal shape returned by /preview/:id/status */
interface PreviewStatus {
  healthy: boolean;
  errors?: string[];
    /** 'type' = advisory TypeScript errors: reported, but the app still builds
     * and runs (Vite strips types without checking them), so it does not mark
     * the preview unhealthy. See previewState.getProjectDiagnostics. */
    diagnosticKind?: 'healthy' | 'validation' | 'runtime' | 'build' | 'service' | 'type';
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
    /**
     * True while the agent's requested npm packages are being installed into the
     * (shared) preview-service node_modules. That install briefly touches modules
     * other in-flight requests can race against, which can surface as a transient
     * build/runtime error unrelated to the user's actual code. Suppress the hard
     * error block during this window and show an "installing" state instead.
     */
    installingDependency?: boolean;
    /** True when the last completed run wrote no files (server-side `ghostRun`:
     * a question, clarification, or refusal). The preview is byte-identical to
     * before the prompt, so it's dimmed with a "no changes" note rather than
     * doing a reveal that implies work landed. Cleared when the next run starts. */
    noChanges?: boolean;
    /** Live agent run state, shown in place of the frame while there is nothing to render. */
    runProgress?: RunProgress;
    /** Workspace still restoring: draw a page skeleton, not a loader, until there is a frame. */
    loading?: boolean;
}

/** Imperative handle for driving the preview iframe's own session history
 * (its HashRouter navigation), the same way browser back/forward buttons
 * drive a real tab. Goes through postMessage rather than calling
 * contentWindow.history.back()/forward() directly   the iframe is
 * cross-origin (preview.ecomgear.app vs the app's own origin), and nav-patch.js
 * (already injected into every preview) runs history.go() same-origin on the
 * other end, the same pattern already used for ecg-inspect-mode below. It
 * also reports the resulting route back to the parent via postMessage. */
export interface MultiDevicePreviewHandle {
    goBack: () => void;
    goForward: () => void;
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

export const MultiDevicePreview = React.forwardRef<MultiDevicePreviewHandle, MultiDevicePreviewProps>(({
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
    installingDependency = false,
    noChanges = false,
    runProgress,
    loading = false,
}, ref) => {
    const config = DEVICE_CONFIGS[viewMode];
    const [previewDiagnostics, setPreviewDiagnostics] = useState<PreviewStatus>({ healthy: true, errors: [], diagnosticKind: 'healthy' });
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [blankScreen, setBlankScreen] = useState(false);
    const blankTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const iframeRef = useRef<HTMLIFrameElement>(null);

    React.useImperativeHandle(ref, () => ({
        goBack: () => iframeRef.current?.contentWindow?.postMessage({ type: 'ecg-nav-go', delta: -1 }, '*'),
        goForward: () => iframeRef.current?.contentWindow?.postMessage({ type: 'ecg-nav-go', delta: 1 }, '*'),
    }), []);

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
        if (loading && !hasRenderableFrame) return <PreviewSkeleton />;
        if ((status === 'building' || installingDependency) && !hasRenderableFrame) {
            return <PreviewPlaceholder progress={runProgress} previewStatus={status} installingDependency={installingDependency} />;
        }

        // If there is no renderable frame yet, show blocking error states.
        // Suppressed while a dependency install is in flight   the shared
        // preview node_modules can transiently error for unrelated reasons
        // during that window, and it isn't the user's code that's broken.
        if (hasBuildErrors && !hasRenderableFrame && !installingDependency) {
            return (
                <PreviewPlaceholder
                    progress={runProgress}
                    previewStatus={status}
                    issue={{ title: blockingCopy.title, description: blockingCopy.description, onRepair: onRepair ? handleRepair : undefined, onRetry: onRefresh }}
                />
            );
        }

        if (status === 'failed' && !hasRenderableFrame) {
            return (
                <PreviewPlaceholder
                    progress={runProgress}
                    previewStatus={status}
                    issue={{ title: 'Something needs fixing', description: 'We detected an issue with the last update.', onRepair: onRepair ? handleRepair : undefined, onRetry: onRefresh }}
                />
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
                    {/* A badge, NOT a cover. Two earlier attempts hid the whole frame while
                        a run was in flight -- first opaque, then blurred -- to mask the
                        reload the HMR-connected Vite server performs on each file write.
                        Both were worse than the flicker they hid: runs last minutes, and a
                        hidden app reads as a frozen or crashed one with the user unable to
                        keep using the page (reported 2026-08-16: "stop getting stuck at
                        applying changes, keep showing the view"). The app stays visible and
                        interactive; this only signals that work is in progress.
                        pointer-events-none so it never eats a click.

                        Gated on status === 'building' ONLY -- the moments files are
                        genuinely being written to the preview. It used to also fire on
                        isGenerating, which is true for the agent's whole run, so
                        "Applying changes" appeared the instant a prompt was sent and sat
                        there for minutes while the agent was still reading and thinking.
                        Nothing was being applied for almost all of that time. The preview
                        is pushed once at the end of a run (repair passes, the other source
                        of mid-run pushes, no longer fire on non-blocking type errors), so
                        this badge is now brief and true rather than long and wrong. */}
                    {status === 'building' && hasRenderableFrame && !installingDependency && (
                        <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-full bg-gray-900/85 px-3 py-1.5 shadow-lg">
                            <div className="animate-spin w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full" />
                            <span className="text-white/85 text-[11px] font-medium">Applying changes…</span>
                        </div>
                    )}
                    {/* noChanges deliberately does NOT touch the preview frame:
                        a no-write run grays out the Publish button (Editor's
                        isVersionPublishable), the preview stays untouched. */}
                    {blankScreen && !hasBuildErrors && !installingDependency && (
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

        return <PreviewPlaceholder progress={runProgress} previewStatus={status} installingDependency={installingDependency} />;
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

        </div>
    );
});

MultiDevicePreview.displayName = 'MultiDevicePreview';

/**
 * The shape of a page, in the space the page will take. Shown while the
 * workspace restores, instead of the full-screen step list that used to
 * cover the whole editor. Static apart from the shared skeleton shimmer.
 */
function PreviewSkeleton() {
    return (
        <div className="h-full w-full overflow-hidden bg-[#0c0c0e] p-6">
            <div className="mx-auto flex max-w-3xl flex-col gap-6">
                <div className="flex items-center gap-3">
                    <div className="skeleton h-6 w-6 rounded-md" />
                    <div className="skeleton h-3 w-24" />
                    <div className="ml-auto flex gap-2"><div className="skeleton h-3 w-12" /><div className="skeleton h-3 w-12" /><div className="skeleton h-3 w-12" /></div>
                    <div className="skeleton h-7 w-20 rounded-full" />
                </div>
                <div className="mt-4 space-y-3">
                    <div className="skeleton h-8 w-3/5" />
                    <div className="skeleton h-8 w-2/5" />
                    <div className="skeleton h-3 w-1/2" />
                </div>
                <div className="grid grid-cols-3 gap-3">
                    {[0, 1, 2].map((i) => (
                        <div key={i} className="space-y-2 rounded-lg border border-white/[0.06] p-3">
                            <div className="skeleton h-20 w-full" />
                            <div className="skeleton h-2.5 w-3/4" />
                            <div className="skeleton h-2.5 w-1/2" />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

export default MultiDevicePreview;
