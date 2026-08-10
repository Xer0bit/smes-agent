import { useQuery } from "@tanstack/react-query";
import { invokeFn } from "@/lib/tenant";
import { useAuth } from "./useAuth";

interface AuthContextResult {
  isAdmin: boolean;
}

/**
 * Standalone role check for places that mount before ClientProvider (e.g.
 * ProtectedRoute, which gates AdminLayout itself). Shares its query cache
 * with useClientContext's own auth-context call (same queryKey), so this
 * doesn't cost a second round trip once both are mounted.
 */
export function useUserRole() {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["auth-context", user?.id],
    queryFn: () => invokeFn<AuthContextResult>("auth-context"),
    enabled: !!user,
  });

  const isAdmin = data?.isAdmin ?? false;
  return {
    roles: isAdmin ? ["admin"] : [],
    isAdmin,
    loading: !!user && isLoading,
  };
}
