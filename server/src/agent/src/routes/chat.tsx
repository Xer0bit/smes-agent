import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root.js";
import ChatPage from "../pages/chat.js";
import { z } from "zod";

export const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: ChatPage,
  validateSearch: z.object({
    id: z.number().optional(),
  }),
});
