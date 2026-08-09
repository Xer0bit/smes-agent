import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export function useClientId() {
  const { user } = useAuth();

  const { data: clientId = null, isLoading } = useQuery({
    queryKey: ["client-id", user?.id],
    queryFn: async () => {
      if (!user) return null;

      // Check for existing mapping
      const { data, error } = await (supabase as any)
        .from("client_users")
        .select("client_id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();
      if (error) throw error;

      if (data?.client_id) return data.client_id as string;

      // No client mapping found — auto-create via edge function
      const companyName = user.user_metadata?.full_name || user.email;
      const { data: setupData, error: setupError } = await supabase.functions.invoke("setup-client", {
        body: { company_name: companyName },
      });

      if (setupError) {
        console.error("Auto-setup client failed:", setupError);
        return null;
      }

      return (setupData?.client_id as string) ?? null;
    },
    enabled: !!user,
  });

  return { clientId, loading: isLoading };
}
