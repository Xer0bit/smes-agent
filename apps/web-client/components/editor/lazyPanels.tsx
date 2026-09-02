import { lazy, Suspense, type ComponentProps } from 'react';

/**
 * Editor panels that are not on screen at first paint, loaded on first use.
 *
 * The editor bundled every dialog and side panel eagerly, so opening a
 * project paid for Settings, version history, the code viewer and the cloud
 * dialog before the chat and preview could appear. Each wrapper here keeps
 * the original component's props and carries its own Suspense, so call sites
 * in Editor.tsx are unchanged: same name, same JSX, later download.
 *
 * `fallback={null}`: these open on a click, and a dialog that appears a beat
 * later reads better than a spinner where the dialog will be.
 *
 * Written out six times rather than through a generic helper: React's
 * LazyExoticComponent prop typing (PropsWithRef) does not survive a generic
 * P, and six plain wrappers are easier to read than the cast that would need.
 */

const LazySettingsDialog = lazy(() => import('@/components/referral/settings/SettingsDialog').then((m) => ({ default: m.SettingsDialog })));
export function SettingsDialog(props: ComponentProps<typeof LazySettingsDialog>) {
  return <Suspense fallback={null}><LazySettingsDialog {...props} /></Suspense>;
}

const LazyCloudRegionDialog = lazy(() => import('@/components/editor/CloudRegionDialog').then((m) => ({ default: m.CloudRegionDialog })));
export function CloudRegionDialog(props: ComponentProps<typeof LazyCloudRegionDialog>) {
  return <Suspense fallback={null}><LazyCloudRegionDialog {...props} /></Suspense>;
}

const LazyVersionHistoryPanel = lazy(() => import('@/components/VersionHistoryPanel').then((m) => ({ default: m.VersionHistoryPanel })));
export function VersionHistoryPanel(props: ComponentProps<typeof LazyVersionHistoryPanel>) {
  return <Suspense fallback={null}><LazyVersionHistoryPanel {...props} /></Suspense>;
}

const LazyRevisionPanel = lazy(() => import('@/components/RevisionPanel').then((m) => ({ default: m.RevisionPanel })));
export function RevisionPanel(props: ComponentProps<typeof LazyRevisionPanel>) {
  return <Suspense fallback={null}><LazyRevisionPanel {...props} /></Suspense>;
}

const LazyCodeEditorPanel = lazy(() => import('@/components/CodeEditorPanel').then((m) => ({ default: m.CodeEditorPanel })));
export function CodeEditorPanel(props: ComponentProps<typeof LazyCodeEditorPanel>) {
  return <Suspense fallback={null}><LazyCodeEditorPanel {...props} /></Suspense>;
}

const LazyGithubStatusPopover = lazy(() => import('@/components/editor/GithubStatusPopover').then((m) => ({ default: m.GithubStatusPopover })));
export function GithubStatusPopover(props: ComponentProps<typeof LazyGithubStatusPopover>) {
  return <Suspense fallback={null}><LazyGithubStatusPopover {...props} /></Suspense>;
}
