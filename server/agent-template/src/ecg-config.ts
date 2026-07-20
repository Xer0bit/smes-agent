// This file is overwritten by the server at injection time with real values.
// Do not edit — changes here will be lost when a dashboard is generated.
export const ECG = {
  appName: 'Dashboard',
  logoUrl: '',
  layout: 'sidebar' as 'sidebar' | 'topnav' | 'minimal',
  modules: ['agents', 'schedulers', 'posts', 'connectors', 'runs', 'knowledge'] as string[],
  showSummaryCards: true,
  accentColor: '#2563eb',
  proxyUrl: '',
  projectId: '',
  moduleSettings: {} as Record<string, Record<string, boolean | string>>,
};
