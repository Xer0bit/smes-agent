import { Outlet } from "react-router-dom";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AdminSidebar } from "@/components/AdminSidebar";
import { useUserRole } from "@/hooks/useUserRole";
import { useClientContext, ClientProvider } from "@/hooks/useClientContext";
import { ClientSelector } from "@/components/ClientSelector";

function AdminLayoutInner() {
  const { isAdmin } = useUserRole();
  const { clients, selectedClientId, setSelectedClientId, clientId } = useClientContext();

  const clientName = (() => {
    if (isAdmin) {
      const selected = clients.find((c) => c.id === selectedClientId);
      return selected ? ` - ${selected.name}` : "";
    }
    const assigned = clients.find((c) => c.id === clientId);
    return assigned ? ` - ${assigned.name}` : "";
  })();

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AdminSidebar />
        <div className="flex-1 flex flex-col">
          <header className="h-14 flex items-center justify-between border-b border-border px-4">
            <div className="flex items-center">
              <SidebarTrigger className="mr-4" />
              <h1 className="font-display font-semibold text-foreground">
                {isAdmin ? "Admin Dashboard" : "FT30 Dashboard"}{clientName}
              </h1>
            </div>
            {isAdmin && (
              <ClientSelector
                clients={clients}
                selectedClientId={selectedClientId}
                onSelect={setSelectedClientId}
              />
            )}
          </header>
          <main className="flex-1 p-6 bg-muted/30">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

const AdminLayout = () => {
  return (
    <ClientProvider>
      <AdminLayoutInner />
    </ClientProvider>
  );
};

export default AdminLayout;
