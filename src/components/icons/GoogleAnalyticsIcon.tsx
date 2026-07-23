// Google Analytics brand mark   the recognizable orange/yellow diamond with
// an ascending bar chart. Shared between GoogleAnalyticsSettings.tsx (the
// connect/property card) and HeaderIntegrationsSettings.tsx (the Measurement
// ID field) so both "attach Google Analytics" touchpoints show the same logo
// instead of a generic lucide chart icon.
export function GoogleAnalyticsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Google Analytics">
      <rect x="4" y="4" width="40" height="40" rx="9" fill="url(#ga-gradient)" />
      <rect x="13" y="26" width="5.5" height="11" rx="1.5" fill="white" />
      <rect x="21.25" y="19" width="5.5" height="18" rx="1.5" fill="white" />
      <rect x="29.5" y="11" width="5.5" height="26" rx="1.5" fill="white" fillOpacity="0.9" />
      <defs>
        <linearGradient id="ga-gradient" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F9AB00" />
          <stop offset="1" stopColor="#E8710A" />
        </linearGradient>
      </defs>
    </svg>
  );
}
