import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root.js";
import AppDetailsPage from "../pages/app-details.js";
import { z } from "zod";

export const appDetailsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app-details",
  component: AppDetailsPage,
  validateSearch: z.object({
    appId: z.number().optional(),
  }),
});
