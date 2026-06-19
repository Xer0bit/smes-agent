import { Route } from "@tanstack/react-router";
import { rootRoute } from "./root.js";
import LibraryHomePage from "@/pages/library-home";

export const libraryRoute = new Route({
  getParentRoute: () => rootRoute,
  path: "/library",
  component: LibraryHomePage,
});
