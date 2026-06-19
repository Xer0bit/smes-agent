/**
 * EditorWithWorkspace
 * Wrapper that adds workspace context to the existing Editor
 * Enables gradual migration to workspace-aware AI editing
 */

import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useParams } from 'react-router-dom';
import { WorkspaceProvider } from '@/contexts/WorkspaceContext';

// Import the actual Editor component
// This wrapper adds workspace context without modifying Editor internals
const EditorLazy = React.lazy(() => import('./Editor'));

const EditorWithWorkspace: React.FC = () => {
    const { projectId } = useParams();

    if (!projectId || projectId === 'undefined') {
        return <div>No project ID provided</div>;
    }

    return (
        <WorkspaceProvider key={projectId} projectId={projectId}>
            <React.Suspense fallback={<EditorLoadingState />}>
                <EditorLazy key={projectId} projectId={projectId} />
            </React.Suspense>
        </WorkspaceProvider>
    );
};

const EditorLoadingState: React.FC = () => {
    const prefersReducedMotion = useReducedMotion();

    return (
        <div className="relative flex h-screen items-center justify-center overflow-hidden bg-[linear-gradient(180deg,hsl(var(--background)),hsl(214_38%_10%))] px-6">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,hsl(var(--primary))/0.16,transparent_30%),radial-gradient(circle_at_80%_20%,hsl(var(--accent))/0.12,transparent_24%)]" />

            <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, y: 16 }}
                animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                className="relative w-full max-w-3xl overflow-hidden rounded-[32px] border border-white/10 bg-[linear-gradient(180deg,rgba(12,23,39,0.96),rgba(10,18,32,0.88))] p-6 shadow-[0_24px_100px_rgba(3,12,27,0.48)] backdrop-blur-xl sm:p-8"
            >
                <div className="mb-6 flex items-center justify-between gap-4">
                    <div>
                        <p className="mb-2 text-xs uppercase tracking-[0.28em] text-primary">Editor</p>
                        <h2 className="text-2xl font-semibold text-foreground">Loading your workspace</h2>
                        <p className="mt-2 text-sm text-muted-foreground">Preparing files, workspace context, and preview services.</p>
                    </div>
                    <motion.div
                        animate={prefersReducedMotion ? undefined : { rotate: 360 }}
                        transition={prefersReducedMotion ? { duration: 0 } : { repeat: Infinity, duration: 1.2, ease: 'linear' }}
                        className="flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10"
                    >
                        <div className="h-5 w-5 rounded-full border-2 border-primary border-t-transparent" />
                    </motion.div>
                </div>

                <div className="mb-8 h-2 overflow-hidden rounded-full bg-white/6">
                    <motion.div
                        className="h-full rounded-full bg-[linear-gradient(90deg,hsl(var(--primary)),hsl(var(--accent)))]"
                        initial={prefersReducedMotion ? false : { scaleX: 0.22, transformOrigin: '0% 50%' }}
                        animate={prefersReducedMotion ? { scaleX: 0.72, transformOrigin: '0% 50%' } : { scaleX: [0.22, 0.68, 0.54, 0.82], transformOrigin: '0% 50%' }}
                        transition={prefersReducedMotion ? { duration: 0 } : { repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
                    />
                </div>

                <div className="grid gap-4 md:grid-cols-[1.3fr_0.8fr]">
                    <div className="rounded-3xl border border-white/8 bg-white/[0.03] p-4">
                        <div className="mb-4 flex gap-2">
                            <div className="h-3 w-3 rounded-full bg-primary/80" />
                            <div className="h-3 w-3 rounded-full bg-secondary/80" />
                            <div className="h-3 w-3 rounded-full bg-accent/80" />
                        </div>
                        <div className="space-y-3">
                            <div className="h-4 w-2/3 rounded-full bg-white/8" />
                            <div className="h-4 w-full rounded-full bg-white/6" />
                            <div className="h-4 w-5/6 rounded-full bg-white/6" />
                            <div className="h-28 rounded-2xl bg-[linear-gradient(135deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))]" />
                        </div>
                    </div>
                    <div className="rounded-3xl border border-white/8 bg-white/[0.03] p-4">
                        <div className="mb-4 h-4 w-1/2 rounded-full bg-white/8" />
                        <div className="space-y-3">
                            <div className="h-12 rounded-2xl bg-white/6" />
                            <div className="h-12 rounded-2xl bg-white/6" />
                            <div className="h-20 rounded-2xl bg-white/6" />
                        </div>
                    </div>
                </div>
            </motion.div>
        </div>
    );
};

export default EditorWithWorkspace;
