import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root.js";
import SettingsPage from "../pages/settings.js";

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});
