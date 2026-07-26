import React, { createContext, useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useUserRole } from "./useUserRole";
import { useClientId } from "./useClientId";

interface Client {
  id: string;
  name: string;
  status: string;
}

interface ClientContextValue {
  clientId: string | null;
  selectedClientId: string | null;
  setSelectedClientId: (id: string | null) => void;
  clients: Client[];
  isSuperAdmin: boolean;
  loading: boolean;
}

const ClientContext = createContext<ClientContextValue>({
  clientId: null,
  selectedClientId: null,
  setSelectedClientId: () => {},
  clients: [],
  isSuperAdmin: false,
  loading: true,
});

export function ClientProvider({ children }: { children: React.ReactNode }) {
  const { isSuperAdmin, loading: roleLoading } = useUserRole();
  const { clientId: assignedClientId, loading: clientLoading } = useClientId();
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const { data: allClients = [], isLoading: clientsLoading } = useQuery({
    queryKey: ["all-clients"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("clients")
        .select("id, name, status")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Client[];
    },
    enabled: isSuperAdmin,
  });

  // For non-super-admin users, fetch their assigned client info
  const { data: assignedClient } = useQuery({
    queryKey: ["assigned-client", assignedClientId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("clients")
        .select("id, name, status")
        .eq("id", assignedClientId)
        .maybeSingle();
      if (error) throw error;
      return data as Client | null;
    },
    enabled: !isSuperAdmin && !!assignedClientId,
  });

  const clients = isSuperAdmin ? allClients : (assignedClient ? [assignedClient] : []);
  const effectiveClientId = isSuperAdmin ? selectedClientId : assignedClientId;
  const loading = roleLoading || clientLoading || (isSuperAdmin && clientsLoading);

  return (
    <ClientContext.Provider value={{
      clientId: effectiveClientId,
      selectedClientId,
      setSelectedClientId,
      clients,
      isSuperAdmin,
      loading,
    }}>
      {children}
    </ClientContext.Provider>
  );
}

export function useClientContext() {
  return useContext(ClientContext);
}
