import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useClientContext } from "@/hooks/useClientContext";
import { Users, Search, Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

interface Lead {
  id: string;
  client_id: string;
  lead_form_id: string | null;
  data: Record<string, any>;
  created_at: string;
}

interface LeadForm {
  id: string;
  form_name: string;
  webhook_url: string | null;
}

interface SheetConfig {
  type: "google_sheet";
  sheet_url: string;
  col_start: string;
  col_end: string;
}

function parseSheetConfig(webhook_url: string | null): SheetConfig | null {
  if (!webhook_url) return null;
  try {
    const cfg = JSON.parse(webhook_url);
    if (cfg.type === "google_sheet") return cfg as SheetConfig;
  } catch {}
  return null;
}

function extractSheetId(url: string): string {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : url;
}

const Leads = () => {
  const { clientId, isSuperAdmin, loading: selectorLoading } = useClientContext();
  const [search, setSearch] = useState("");
  const [filterFormId, setFilterFormId] = useState<string | null>(null);

  const { data: leadForms = [] } = useQuery({
    queryKey: ["lead-forms", clientId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("lead_forms").select("id, form_name, webhook_url").eq("client_id", clientId).order("created_at");
      if (error) throw error;
      return (data ?? []) as LeadForm[];
    },
    enabled: !!clientId,
  });

  // Standard DB leads
  const { data: leads = [], isLoading } = useQuery({
    queryKey: ["leads", clientId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("leads").select("*").eq("client_id", clientId).order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Lead[];
    },
    enabled: !!clientId,
  });

  // Google Sheet data for forms that have sheet config
  const sheetForms = useMemo(() => leadForms.filter(f => parseSheetConfig(f.webhook_url)), [leadForms]);

  const { data: sheetData = {}, isLoading: sheetLoading } = useQuery({
    queryKey: ["sheet-leads", clientId, sheetForms.map(f => f.id).join(",")],
    queryFn: async () => {
      const results: Record<string, { headers: string[]; rows: Record<string, string>[] }> = {};
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;

      await Promise.all(sheetForms.map(async (form) => {
        const cfg = parseSheetConfig(form.webhook_url)!;
        try {
          const res = await fetch(`https://${projectId}.supabase.co/functions/v1/fetch-google-sheet`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            },
            body: JSON.stringify({
              sheet_id: extractSheetId(cfg.sheet_url),
              col_start: cfg.col_start,
              col_end: cfg.col_end,
            }),
          });
          const data = await res.json();
          if (data.ok && data.headers) {
            results[form.id] = { headers: data.headers, rows: data.rows };
          }
        } catch (err) {
          console.error("Sheet fetch error:", err);
        }
      }));
      return results;
    },
    enabled: sheetForms.length > 0,
    staleTime: 60_000,
  });

  // Determine which form is selected and what data to show
  const selectedForm = filterFormId ? leadForms.find(f => f.id === filterFormId) : null;
  const selectedSheetConfig = selectedForm ? parseSheetConfig(selectedForm.webhook_url) : null;

  // For sheet view
  const currentSheetData = filterFormId && sheetData[filterFormId] ? sheetData[filterFormId] : null;

  // For DB leads view
  const allKeys = useMemo(() => {
    const keys = new Set<string>();
    leads.forEach((l) => Object.keys(l.data).forEach((k) => keys.add(k)));
    return Array.from(keys);
  }, [leads]);

  const filtered = useMemo(() => {
    let result = leads;
    if (filterFormId) {
      // If it's a sheet form, don't filter DB leads
      if (selectedSheetConfig) return [];
      result = result.filter((l) => l.lead_form_id === filterFormId);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((l) =>
        Object.values(l.data).some((v) => String(v).toLowerCase().includes(q))
      );
    }
    return result;
  }, [leads, search, filterFormId, selectedSheetConfig]);

  // Filter sheet rows by search
  const filteredSheetRows = useMemo(() => {
    if (!currentSheetData) return [];
    if (!search.trim()) return currentSheetData.rows;
    const q = search.toLowerCase();
    return currentSheetData.rows.filter(row =>
      Object.values(row).some(v => String(v).toLowerCase().includes(q))
    );
  }, [currentSheetData, search]);

  const formName = (id: string | null) => leadForms.find((f) => f.id === id)?.form_name ?? "—";

  const isShowingSheet = !!selectedSheetConfig && !!currentSheetData;

  const exportCsv = () => {
    if (isShowingSheet) {
      if (filteredSheetRows.length === 0) return;
      const cols = currentSheetData!.headers;
      const rows = filteredSheetRows.map(row => cols.map(h => String(row[h] ?? "")));
      const csv = [cols.join(","), ...rows.map(r => r.map(c => `"${c}"`).join(","))].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `leads_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      if (filtered.length === 0) return;
      const cols = ["created_at", "form", ...allKeys];
      const rows = filtered.map((l) => [
        new Date(l.created_at).toLocaleString(),
        formName(l.lead_form_id),
        ...allKeys.map((k) => String(l.data[k] ?? "")),
      ]);
      const csv = [cols.join(","), ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `leads_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const totalCount = isShowingSheet ? filteredSheetRows.length : filtered.length;
  const exportDisabled = totalCount === 0;

  if (selectorLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!clientId && !isSuperAdmin) {
    return (
      <div className="bg-card border border-border rounded-xl p-12 text-center">
        <Users className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
        <h3 className="font-display font-semibold text-foreground mb-1">No client account linked</h3>
        <p className="text-muted-foreground text-sm font-body">
          Ask your super admin to assign you to a client account.
        </p>
      </div>
    );
  }

  if (!clientId) {
    return (
      <div className="bg-card border border-border rounded-xl p-12 text-center">
        <Users className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
        <h3 className="font-display font-semibold text-foreground mb-1">Select a client</h3>
        <p className="text-muted-foreground text-sm font-body">Choose a client from the header to view their leads.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold text-foreground">Sales Leads</h2>
          <p className="text-muted-foreground font-body text-sm">
            View and manage leads from connected forms.{" "}
            {isShowingSheet
              ? `${filteredSheetRows.length} rows from Google Sheet.`
              : `${leads.length} total leads.`}
          </p>
        </div>
        <Button variant="hero" size="sm" onClick={exportCsv} disabled={exportDisabled}>
          <Download className="h-4 w-4 mr-1" /> Export CSV
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search leads…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        {leadForms.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            <Button variant={filterFormId === null ? "default" : "outline"} size="sm" onClick={() => setFilterFormId(null)}>All Forms</Button>
            {leadForms.map((f) => {
              const isSheet = !!parseSheetConfig(f.webhook_url);
              return (
                <Button key={f.id} variant={filterFormId === f.id ? "default" : "outline"} size="sm" onClick={() => setFilterFormId(f.id)}>
                  {isSheet && <FileSpreadsheet className="h-3.5 w-3.5 mr-1" />}
                  {f.form_name}
                </Button>
              );
            })}
          </div>
        )}
      </div>

      {(isLoading || sheetLoading) ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading…</div>
      ) : isShowingSheet ? (
        /* Google Sheet table */
        filteredSheetRows.length === 0 ? (
          <div className="bg-card border border-border rounded-xl p-12 text-center">
            <FileSpreadsheet className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
            <h3 className="font-display font-semibold text-foreground mb-1">No rows found</h3>
            <p className="text-muted-foreground text-sm font-body">
              {search.trim() ? "Try adjusting your search." : "The connected Google Sheet appears to be empty."}
            </p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {currentSheetData!.headers.map((h) => (
                    <TableHead key={h}>{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSheetRows.map((row, i) => (
                  <TableRow key={i}>
                    {currentSheetData!.headers.map((h) => (
                      <TableCell key={h} className="text-sm max-w-[200px] truncate">{row[h] || "—"}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      ) : filtered.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <FileSpreadsheet className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
          <h3 className="font-display font-semibold text-foreground mb-1">No leads found</h3>
          <p className="text-muted-foreground text-sm font-body">
            {leads.length === 0 ? "Leads will appear here once they come in through your connected forms." : "Try adjusting your search or filter."}
          </p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Form</TableHead>
                {allKeys.slice(0, 6).map((k) => (
                  <TableHead key={k} className="capitalize">{k.replace(/_/g, " ")}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((lead) => (
                <TableRow key={lead.id}>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{new Date(lead.created_at).toLocaleDateString()}</TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{formName(lead.lead_form_id)}</Badge></TableCell>
                  {allKeys.slice(0, 6).map((k) => (
                    <TableCell key={k} className="text-sm max-w-[150px] truncate">{String(lead.data[k] ?? "—")}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};

export default Leads;
