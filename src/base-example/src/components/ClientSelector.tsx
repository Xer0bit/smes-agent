import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Building2 } from "lucide-react";

interface Client {
  id: string;
  name: string;
  status: string;
}

interface ClientSelectorProps {
  clients: Client[];
  selectedClientId: string | null;
  onSelect: (id: string) => void;
}

export function ClientSelector({ clients, selectedClientId, onSelect }: ClientSelectorProps) {
  if (clients.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
      <Select value={selectedClientId ?? ""} onValueChange={onSelect}>
        <SelectTrigger className="w-[220px]">
          <SelectValue placeholder="Select a client…" />
        </SelectTrigger>
        <SelectContent>
          {clients.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name} {c.status !== "active" ? `(${c.status})` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
