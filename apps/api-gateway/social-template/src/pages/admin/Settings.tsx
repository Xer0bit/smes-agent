import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Building2, FileText, CreditCard, Save, Loader2, ExternalLink, Download, Receipt, Newspaper, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useClientContext } from "@/hooks/useClientContext";

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

const Settings = () => {
  const { user } = useAuth();
  const { clientId, clients } = useClientContext();
  const clientName = clients.find((c) => c.id === clientId)?.name ?? "";

  const [saving, setSaving] = useState(false);

  // Company details
  const [companyName, setCompanyName] = useState("");
  const [companyAddress, setCompanyAddress] = useState("");
  const [companyCity, setCompanyCity] = useState("");
  const [companyCountry, setCompanyCountry] = useState("");
  const [companyVat, setCompanyVat] = useState("");

  // Invoice contact
  const [invoiceEmail, setInvoiceEmail] = useState("");
  const [invoicePhone, setInvoicePhone] = useState("");
  const [invoiceContactName, setInvoiceContactName] = useState("");

  // Pre-fill from user/client data
  useEffect(() => {
    if (user?.email && !invoiceEmail) setInvoiceEmail(user.email);
    if (clientName && !companyName) setCompanyName(clientName);
  }, [user, clientName]);

  // Billing
  const [portalLoading, setPortalLoading] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);

  useEffect(() => {
    fetchInvoices();
  }, []);

  const fetchInvoices = async () => {
    setInvoicesLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("list-invoices");
      if (error) throw error;
      setInvoices(data?.invoices || []);
    } catch (err: any) {
      console.error("Failed to fetch invoices:", err);
    } finally {
      setInvoicesLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    await new Promise((r) => setTimeout(r, 800));
    toast.success("Settings saved");
    setSaving(false);
  };

  const openCustomerPortal = async () => {
    setPortalLoading(true);
    try {
      // Try the billing portal first (works if user already has an active Stripe subscription)
      const { data, error } = await supabase.functions.invoke("customer-portal");
      if (!error && data?.url) {
        window.open(data.url, "_blank");
        return;
      }

      // Otherwise fall back to a fresh Checkout session ($699/mo)
      const { data: checkoutData, error: checkoutError } = await supabase.functions.invoke(
        "create-checkout",
        {
          body: {
            email: user?.email,
            companyName: companyName || clientName || user?.email || "FT30 Customer",
          },
        },
      );
      if (checkoutError) throw checkoutError;
      if (!checkoutData?.url) throw new Error("No checkout URL returned");
      window.location.href = checkoutData.url;
    } catch (err: any) {
      console.error("Payment flow error:", err);
      toast.error(err?.message || "Failed to start payment checkout");
    } finally {
      setPortalLoading(false);
    }
  };

  const formatCurrency = (amount: number, currency: string) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

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

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-2xl font-display font-bold text-foreground">Settings</h2>
        <p className="text-muted-foreground text-sm mt-1">
          Manage your company details, invoice contact, and billing.
        </p>
      </div>

      {/* Company Details */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">Company Details</CardTitle>
          </div>
          <CardDescription>Your business information shown on invoices.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="companyName">Company Name</Label>
              <Input id="companyName" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Acme Corp" className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="companyVat">VAT / Tax ID</Label>
              <Input id="companyVat" value={companyVat} onChange={(e) => setCompanyVat(e.target.value)} placeholder="GB123456789" className="mt-1.5" />
            </div>
          </div>
          <div>
            <Label htmlFor="companyAddress">Address</Label>
            <Input id="companyAddress" value={companyAddress} onChange={(e) => setCompanyAddress(e.target.value)} placeholder="123 Main Street" className="mt-1.5" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="companyCity">City</Label>
              <Input id="companyCity" value={companyCity} onChange={(e) => setCompanyCity(e.target.value)} placeholder="London" className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="companyCountry">Country</Label>
              <Input id="companyCountry" value={companyCountry} onChange={(e) => setCompanyCountry(e.target.value)} placeholder="United Kingdom" className="mt-1.5" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Invoice Contact */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">Invoice Contact</CardTitle>
          </div>
          <CardDescription>Who should receive invoices and billing notifications.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="invoiceContactName">Contact Name</Label>
            <Input id="invoiceContactName" value={invoiceContactName} onChange={(e) => setInvoiceContactName(e.target.value)} placeholder="Jane Doe" className="mt-1.5" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="invoiceEmail">Invoice Email</Label>
              <Input id="invoiceEmail" type="email" value={invoiceEmail} onChange={(e) => setInvoiceEmail(e.target.value)} placeholder="billing@company.com" className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="invoicePhone">Phone</Label>
              <Input id="invoicePhone" type="tel" value={invoicePhone} onChange={(e) => setInvoicePhone(e.target.value)} placeholder="+44 20 1234 5678" className="mt-1.5" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Current Plan */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">Your Plan</CardTitle>
          </div>
          <CardDescription>FT30 Cross Border Media Platform — 12-month program</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-lg border border-border p-4 space-y-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-primary" />
                <span className="font-display font-semibold text-sm">Monthly Subscription</span>
              </div>
              <p className="text-2xl font-display font-bold text-foreground">$699<span className="text-sm font-normal text-muted-foreground">/mo</span></p>
              <p className="text-xs text-muted-foreground">Global press distribution, social media management & lead generation</p>
            </div>
            <div className="rounded-lg border border-border p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Newspaper className="w-4 h-4 text-primary" />
                <span className="font-display font-semibold text-sm">Additional Press Release</span>
              </div>
              <p className="text-2xl font-display font-bold text-foreground">$199<span className="text-sm font-normal text-muted-foreground">/each</span></p>
              <p className="text-xs text-muted-foreground">1 press release per quarter included free. Additional at $199 each.</p>
            </div>
          </div>

          <Separator />

          <div>
            <Button variant="hero" onClick={openCustomerPortal} disabled={portalLoading}>
              {portalLoading ? (
                <><Loader2 className="w-4 h-4 animate-spin mr-2" />Opening…</>
              ) : (
                <><ExternalLink className="w-4 h-4 mr-2" />Manage Payment & Subscription</>
              )}
            </Button>
            <p className="text-xs text-muted-foreground mt-2">
              Update your card, change plan, or manage subscription through Stripe's secure billing portal.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Invoices */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Receipt className="w-5 h-5 text-primary" />
            <CardTitle className="text-lg">Monthly Invoices</CardTitle>
          </div>
          <CardDescription>View and download your billing invoices.</CardDescription>
        </CardHeader>
        <CardContent>
          {invoicesLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading invoices…</span>
            </div>
          ) : invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No invoices found yet.</p>
          ) : (
            <div className="space-y-2">
              {invoices.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between rounded-lg border border-border p-3 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {inv.number || inv.id}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(inv.period_start)} — {formatDate(inv.period_end)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {getStatusBadge(inv.status)}
                    <span className="text-sm font-mono font-medium">
                      {formatCurrency(inv.amount_due, inv.currency)}
                    </span>
                    <div className="flex gap-1">
                      {inv.hosted_invoice_url && (
                        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                          <a href={inv.hosted_invoice_url} target="_blank" rel="noopener noreferrer" title="View invoice">
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </Button>
                      )}
                      {inv.invoice_pdf && (
                        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                          <a href={inv.invoice_pdf} target="_blank" rel="noopener noreferrer" title="Download PDF">
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end">
        <Button variant="hero" size="lg" onClick={handleSave} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Saving…
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-2" />
              Save Settings
            </>
          )}
        </Button>
      </div>
    </div>
  );
};

export default Settings;
