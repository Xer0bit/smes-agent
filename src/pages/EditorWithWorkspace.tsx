/**
 * EditorWithWorkspace
 * Wrapper that adds workspace context to the existing Editor
 * Enables gradual migration to workspace-aware AI editing
 */

import React from 'react';
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

const EditorLoadingState: React.FC = () => (
    <div className="h-screen w-screen bg-[#09090b]" />
);

export default EditorWithWorkspace;
