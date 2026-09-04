import { createContext, useContext } from "react";
import type { User } from "@supabase/supabase-js";

interface LandingContextType {
  user: User | null;
  onLoginClick: () => void;
  onLaunch: () => void;
}

export const LandingContext = createContext<LandingContextType>({
  user: null,
  onLoginClick: () => {},
  onLaunch: () => {},
});

export const useLandingContext = () => useContext(LandingContext);
