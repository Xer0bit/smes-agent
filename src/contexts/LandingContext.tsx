import { createContext, useContext } from "react";
import type { User } from "@supabase/supabase-js";

interface LandingContextType {
  user: User | null;
  onLoginClick: () => void;
}

export const LandingContext = createContext<LandingContextType>({
  user: null,
  onLoginClick: () => {},
});

export const useLandingContext = () => useContext(LandingContext);
