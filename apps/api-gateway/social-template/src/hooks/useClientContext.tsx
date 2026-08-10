import React, { createContext, useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invokeFn } from "@/lib/tenant";
import { useAuth } from "./useAuth";

interface Client {
  id: string;
  name: string;
  status: string;
}

interface AuthContextResult {
  authUserId: string;
  email: string;
  fullName: string | null;
  isAdmin: boolean;
  clientIds: string[];
  clients: Client[];
}

interface ClientContextValue {
  clientId: string | null;
  selectedClientId: string | null;
  setSelectedClientId: (id: string | null) => void;
  clients: Client[];
  isAdmin: boolean;
  /** roles vocabulary this app knows -- kept for ProtectedRoute's requiredRole check. */
  roles: string[];
  loading: boolean;
}

const ClientContext = createContext<ClientContextValue>({
  clientId: null,
  selectedClientId: null,
  setSelectedClientId: () => {},
  clients: [],
  isAdmin: false,
  roles: [],
  loading: true,
});

export function ClientProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  // The ONE call that bootstraps identity: verifies the caller against cloud
  // auth, provisions their profile on first login, and returns role + client
  // memberships -- see edge-functions/auth-context.js.
  const { data, isLoading } = useQuery({
    queryKey: ["auth-context", user?.id],
    queryFn: () => invokeFn<AuthContextResult>("auth-context"),
    enabled: !!user,
  });

  const isAdmin = data?.isAdmin ?? false;
  const clients = data?.clients ?? [];
  const clientIds = data?.clientIds ?? [];
  const assignedClientId = !isAdmin && clientIds.length > 0 ? clientIds[0] : null;
  const effectiveClientId = isAdmin ? selectedClientId : assignedClientId;
  const loading = authLoading || (!!user && isLoading);

  return (
    <ClientContext.Provider value={{
      clientId: effectiveClientId,
      selectedClientId,
      setSelectedClientId,
      clients,
      isAdmin,
      roles: isAdmin ? ["admin"] : [],
      loading,
    }}>
      {children}
    </ClientContext.Provider>
  );
}

export function useClientContext() {
  return useContext(ClientContext);
}
