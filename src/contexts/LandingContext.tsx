import { createContext, useContext } from "react";
import type { User } from "@supabase/supabase-js";
import type { DesignTemplate } from "@/data/designTemplates";

interface LandingContextType {
  user: User | null;
  onLoginClick: () => void;
  onUseTemplate?: (template: DesignTemplate) => void;
}

export const LandingContext = createContext<LandingContextType>({
  user: null,
  onLoginClick: () => {},
});

export const useLandingContext = () => useContext(LandingContext);
