import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root.js";
import HomePage from "../pages/home.js";
import { z } from "zod";
export const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
  validateSearch: z.object({
    appId: z.number().optional(),
  }),
});
