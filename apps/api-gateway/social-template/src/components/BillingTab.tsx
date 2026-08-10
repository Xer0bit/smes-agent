import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Receipt, CreditCard, Loader2, Download, ExternalLink, Send, Newspaper,
} from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from "@/components/ui/dialog";

interface PaymentMethod {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
}

interface SubscriptionInfo {
  id: string;
  status: string;
}

interface Invoice {
  id: string;
  number: string | null;
  status: string | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  created: number;
  period_start: number;
  period_end: number;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
}

interface ClientUser {
  id: string;
  email: string | null;
  fullName: string | null;
}

interface BillingTabProps {
  clientId: string;
  clientUsers: ClientUser[];
}

const formatCurrency = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);

const formatDate = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

const getStatusBadge = (status: string | null) => {
  switch (status) {
    case "paid":
      return <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">Paid</Badge>;
    case "open":
      return <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">Open</Badge>;
    case "draft":
      return <Badge variant="secondary">Draft</Badge>;
    case "void":
      return <Badge variant="outline">Void</Badge>;
    default:
      return <Badge variant="outline">{status || "Unknown"}</Badge>;
  }
};

export function BillingTab({ clientId, clientUsers }: BillingTabProps) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [invoiceDialog, setInvoiceDialog] = useState(false);
  const [pressQty, setPressQty] = useState(1);
  const [invoiceDesc, setInvoiceDesc] = useState("");

  const clientEmail = clientUsers[0]?.email || "";

  useEffect(() => {
    if (clientEmail) fetchClientInvoices();
  }, [clientEmail]);

  const fetchClientInvoices = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("list-invoices-admin", {
        body: { customer_email: clientEmail },
      });
      if (error) throw error;
      setInvoices(data?.invoices || []);
      setPaymentMethod(data?.payment_method || null);
      setSubscription(data?.subscription || null);
    } catch (err: any) {
      console.error("Failed to fetch client invoices:", err);
    } finally {
      setLoading(false);
    }
  };

  const invoiceMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("invoice-press-release", {
        body: {
          customer_email: clientEmail,
          quantity: pressQty,
          description: invoiceDesc || undefined,
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast.success(`Invoice ${data.invoice_number} created — ${formatCurrency(data.amount_due, "usd")}`);
      setInvoiceDialog(false);
      setPressQty(1);
      setInvoiceDesc("");
      fetchClientInvoices();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-6">
      {/* Pricing Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-1">
            <CreditCard className="w-4 h-4 text-primary" />
            <span className="font-display font-semibold text-sm">Monthly Subscription</span>
          </div>
          <p className="text-xl font-display font-bold text-foreground">$699<span className="text-sm font-normal text-muted-foreground">/mo</span></p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-1">
            <Newspaper className="w-4 h-4 text-primary" />
            <span className="font-display font-semibold text-sm">Additional Press Release</span>
          </div>
          <p className="text-xl font-display font-bold text-foreground">$199<span className="text-sm font-normal text-muted-foreground">/each</span></p>
          <p className="text-xs text-muted-foreground">1/quarter free</p>
        </div>
      </div>

      {/* Payment Method Status */}
      {clientEmail && !loading && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-primary" />
              <span className="font-display font-semibold text-sm">Payment Method</span>
            </div>
            {paymentMethod ? (
              <div className="flex items-center gap-2">
                <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                  On file
                </Badge>
                <span className="text-sm font-mono text-muted-foreground">
                  {paymentMethod.brand.toUpperCase()} •••• {paymentMethod.last4} · exp {String(paymentMethod.exp_month).padStart(2, "0")}/{String(paymentMethod.exp_year).slice(-2)}
                </span>
              </div>
            ) : (
              <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                {subscription ? "No card on file" : "No payment info — checkout not completed"}
              </Badge>
            )}
          </div>
          {subscription && (
            <p className="text-xs text-muted-foreground mt-2">
              Subscription status: <span className="font-medium">{subscription.status}</span>
            </p>
          )}
        </div>
      )}


      {/* Invoice Actions */}
      <div className="flex items-center justify-between">
        <h3 className="font-display font-bold text-lg text-foreground">Invoices</h3>
        <Button variant="hero" size="sm" onClick={() => setInvoiceDialog(true)} disabled={!clientEmail}>
          <Send className="h-4 w-4 mr-1" /> Invoice Press Release
        </Button>
      </div>

      {!clientEmail ? (
        <div className="bg-card border border-border rounded-xl p-10 text-center">
          <Receipt className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-muted-foreground text-sm">No client user email found. Add a user first to manage billing.</p>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Loading invoices…</span>
        </div>
      ) : invoices.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-10 text-center">
          <Receipt className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-muted-foreground text-sm">No invoices found for this client.</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-mono text-sm">{inv.number || inv.id.slice(0, 16)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(inv.period_start)} — {formatDate(inv.period_end)}
                  </TableCell>
                  <TableCell>{getStatusBadge(inv.status)}</TableCell>
                  <TableCell className="text-right font-mono font-medium text-sm">
                    {formatCurrency(inv.amount_due, inv.currency)}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {inv.hosted_invoice_url && (
                        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                          <a href={inv.hosted_invoice_url} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </Button>
                      )}
                      {inv.invoice_pdf && (
                        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                          <a href={inv.invoice_pdf} target="_blank" rel="noopener noreferrer">
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Invoice Dialog */}
      <Dialog open={invoiceDialog} onOpenChange={setInvoiceDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Invoice Additional Press Release</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Client Email</Label>
              <Input value={clientEmail} disabled className="mt-1.5 font-mono text-sm" />
            </div>
            <div>
              <Label>Quantity</Label>
              <Input
                type="number"
                min={1}
                max={10}
                value={pressQty}
                onChange={(e) => setPressQty(Math.max(1, Number(e.target.value)))}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Input
                value={invoiceDesc}
                onChange={(e) => setInvoiceDesc(e.target.value)}
                placeholder="e.g. Q2 2026 extra press releases"
                className="mt-1.5"
              />
            </div>
            <div className="rounded-lg bg-muted/50 p-3">
              <p className="text-sm font-medium">
                Total: <span className="font-mono">${(pressQty * 199).toLocaleString()}</span>
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Invoice will be sent to {clientEmail} with 30-day payment terms.
              </p>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button variant="hero" onClick={() => invoiceMutation.mutate()} disabled={invoiceMutation.isPending}>
              {invoiceMutation.isPending ? (
                <><Loader2 className="w-4 h-4 animate-spin mr-1" />Sending…</>
              ) : (
                <><Send className="w-4 h-4 mr-1" />Send Invoice</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
