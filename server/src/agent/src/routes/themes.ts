import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root.js";
import ThemesPage from "@/pages/themes";

export const themesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/themes",
  component: ThemesPage,
});
