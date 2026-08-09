import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Building2, Plus, Trash2, Settings2, ChevronRight, Ban, CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from "@/components/ui/dialog";

interface Client {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

const Clients = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [clientDialogOpen, setClientDialogOpen] = useState(false);
  const [clientName, setClientName] = useState("");
  const [editingClient, setEditingClient] = useState<Client | null>(null);

  const { data: clients = [], isLoading } = useQuery({
    queryKey: ["clients"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("clients")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Client[];
    },
  });

  const clientMutation = useMutation({
    mutationFn: async () => {
      if (editingClient) {
        const { error } = await (supabase as any)
          .from("clients")
          .update({ name: clientName.trim() })
          .eq("id", editingClient.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any)
          .from("clients")
          .insert({ name: clientName.trim() });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["all-clients"] });
      toast.success(editingClient ? "Client updated" : "Client created");
      setClientDialogOpen(false);
      setClientName("");
      setEditingClient(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleStatusMutation = useMutation({
    mutationFn: async ({ id, newStatus }: { id: string; newStatus: string }) => {
      const { error } = await (supabase as any)
        .from("clients")
        .update({ status: newStatus })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["all-clients"] });
      toast.success("Client status updated");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteClientMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from("clients").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["all-clients"] });
      toast.success("Client deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold text-foreground">Client Management</h2>
          <p className="text-muted-foreground font-body text-sm">
            Manage client accounts and their configurations.
          </p>
        </div>
        <Button
          variant="hero"
          size="sm"
          onClick={() => {
            setEditingClient(null);
            setClientName("");
            setClientDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-1" /> New Client
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading…</div>
      ) : clients.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Building2 className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
          <h3 className="font-display font-semibold text-foreground mb-1">No clients yet</h3>
          <p className="text-muted-foreground text-sm font-body">Create your first client to get started.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {clients.map((client) => (
            <div
              key={client.id}
              onClick={() => navigate(`/admin/clients/${client.id}`)}
              className="flex items-center justify-between px-5 py-4 rounded-xl border border-border bg-card hover:border-primary/30 hover:shadow-gold transition-all cursor-pointer group"
            >
              <div className="flex items-center gap-4">
                <Building2 className="h-5 w-5 text-muted-foreground" />
                <div>
                  <span className="font-display font-semibold text-foreground">{client.name}</span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Badge
                      className={
                        client.status === "active"
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
                          : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                      }
                    >
                      {client.status === "active" ? "Active" : "Suspended"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      Created {new Date(client.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingClient(client);
                    setClientName(client.name);
                    setClientDialogOpen(true);
                  }}
                >
                  <Settings2 className="h-4 w-4 text-muted-foreground" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleStatusMutation.mutate({
                      id: client.id,
                      newStatus: client.status === "active" ? "suspended" : "active",
                    });
                  }}
                >
                  {client.status === "active" ? (
                    <Ban className="h-4 w-4 text-amber-500" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm("Delete this client and all its data?")) {
                      deleteClientMutation.mutate(client.id);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
                <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={clientDialogOpen} onOpenChange={setClientDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">
              {editingClient ? "Edit Client" : "New Client"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="font-body">Client Name</Label>
              <Input
                placeholder="e.g. Acme Corp"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="hero"
              onClick={() => clientMutation.mutate()}
              disabled={!clientName.trim() || clientMutation.isPending}
            >
              {clientMutation.isPending ? "Saving…" : editingClient ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Clients;
