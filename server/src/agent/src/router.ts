import { createRouter } from "@tanstack/react-router";
import { rootRoute } from "./routes/root.js";
import { homeRoute } from "./routes/home.js";
import { chatRoute } from "./routes/chat.js";
import { settingsRoute } from "./routes/settings.js";
import { providerSettingsRoute } from "./routes/settings/providers/$provider.js";
import { appDetailsRoute } from "./routes/app-details.js";
import { hubRoute } from "./routes/hub.js";
import { libraryRoute } from "./routes/library.js";
import { themesRoute } from "./routes/themes.js";
import { promptsRoute } from "./routes/prompts.js";
import { mediaRoute } from "./routes/media.js";

const routeTree = rootRoute.addChildren([
  homeRoute,
  hubRoute,
  libraryRoute,
  themesRoute,
  promptsRoute,
  mediaRoute,
  chatRoute,
  appDetailsRoute,
  settingsRoute.addChildren([providerSettingsRoute]),
]);

// src/components/NotFoundRedirect.tsx
import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { ErrorBoundary } from "./components/ErrorBoundary.js";

export function NotFoundRedirect() {
  const navigate = useNavigate();

  React.useEffect(() => {
    // Navigate to the main route ('/') immediately on mount
    // 'replace: true' prevents the invalid URL from being added to browser history
    navigate({ to: "/", replace: true });
  }, [navigate]); // Dependency array ensures this runs only once

  // Optionally render null or a loading indicator while redirecting
  // The redirect is usually very fast, so null is often fine.
  return null;
  // Or: return <div>Redirecting...</div>;
}

export const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFoundRedirect,
  defaultErrorComponent: ErrorBoundary,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
