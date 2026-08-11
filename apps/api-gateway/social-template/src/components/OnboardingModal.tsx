import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, ArrowRight, Building2, Globe, Target, Rocket, Loader2, Linkedin, Instagram, Facebook, Twitter, Youtube } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const PLATFORM_ICONS = [Linkedin, Instagram, Facebook, Twitter, Youtube];

interface OnboardingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const OnboardingModal = ({ open, onOpenChange }: OnboardingModalProps) => {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const STEPS = [
    { num: 1, icon: Building2, label: t("modal.signUp") },
    { num: 2, icon: Globe, label: t("modal.brand") },
    { num: 3, icon: Target, label: t("modal.leadsStep") },
    { num: 4, icon: Rocket, label: t("modal.go") },
  ];

  const handleSignUp = async () => {
    if (!email.trim() || !password.trim()) {
      toast.error(t("modal.fillAllFields"));
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { full_name: companyName.trim() },
          emailRedirectTo: window.location.origin + "/admin",
        },
      });
      if (error) throw error;

      await supabase.functions.invoke("setup-client", {
        body: { company_name: companyName.trim() },
      });

      // Create Stripe Checkout session for $699/mo recurring subscription
      const { data: checkoutData, error: checkoutError } = await supabase.functions.invoke(
        "create-checkout",
        { body: { email: email.trim(), companyName: companyName.trim() } }
      );
      if (checkoutError) throw checkoutError;

      if (checkoutData?.url) {
        toast.success(t("modal.accountCreated"));
        resetAndClose(false);
        window.location.href = checkoutData.url;
        return;
      }

      toast.success(t("modal.accountCreated"));
      resetAndClose(false);
      navigate("/admin");
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || t("modal.accountFailed"));
    } finally {
      setLoading(false);
    }
  };

  const resetAndClose = (open: boolean) => {
    if (!open) {
      setStep(1);
      setCompanyName("");
      setEmail("");
      setPassword("");
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={resetAndClose}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
        <div className="flex border-b border-border">
          {STEPS.map((s) => (
            <div key={s.num} className={`flex-1 h-1 transition-colors ${s.num <= step ? "bg-primary" : "bg-muted"}`} />
          ))}
        </div>

        <div className="flex justify-center gap-6 pt-6 pb-2">
          {STEPS.map(({ num, icon: Icon, label }) => (
            <div key={num} className="flex flex-col items-center gap-1">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                num === step ? "bg-primary text-primary-foreground" : num < step ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
              }`}>
                {num < step ? <Check className="w-5 h-5" /> : <Icon className="w-5 h-5" />}
              </div>
              <span className={`text-xs font-medium ${num === step ? "text-foreground" : "text-muted-foreground"}`}>{label}</span>
            </div>
          ))}
        </div>

        <div className="p-6 pt-4">
          {step === 1 && (
            <div className="space-y-5">
              <div className="text-center mb-6">
                <h2 className="font-display text-2xl font-bold">{t("modal.globalPress")}</h2>
                <p className="text-muted-foreground text-sm mt-1 max-w-sm mx-auto">{t("modal.globalPressDesc")}</p>
              </div>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="company">{t("modal.companyName")}</Label>
                  <Input id="company" placeholder={t("modal.companyPlaceholder")} value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="email">{t("modal.businessEmail")}</Label>
                  <Input id="email" type="email" placeholder={t("modal.emailPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="password">{t("modal.password")}</Label>
                  <Input id="password" type="password" placeholder={t("modal.passwordPlaceholder")} value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1.5" />
                </div>
              </div>
              <Button variant="hero" className="w-full" size="lg" onClick={() => {
                if (!companyName.trim() || !email.trim() || !password.trim()) {
                  toast.error(t("modal.fillAllFields"));
                  return;
                }
                setStep(2);
              }}>
                {t("modal.continue")} <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div className="text-center mb-4">
                <h2 className="font-display text-2xl font-bold">{t("modal.globalBrandBuilding")}</h2>
                <p className="text-muted-foreground text-sm mt-1 max-w-sm mx-auto">{t("modal.globalBrandDesc")}</p>
                <div className="mt-4 flex items-center justify-center gap-3">
                  {PLATFORM_ICONS.map((PlatformIcon, i) => (
                    <div key={i} className="w-9 h-9 rounded-lg bg-card border border-border flex items-center justify-center">
                      <PlatformIcon className="w-4 h-4 text-muted-foreground" />
                    </div>
                  ))}
                </div>
              </div>
              <div className="border border-border rounded-xl p-5 space-y-3">
                <ul className="space-y-2">
                  {[t("modal.brandFeature1"), t("modal.brandFeature2"), t("modal.brandFeature3"), t("modal.brandFeature4"), t("modal.brandFeature5")].map((item) => (
                    <li key={item} className="flex items-start gap-2 text-sm">
                      <Check className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                      <span className="text-secondary-foreground">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={() => setStep(1)}>{t("modal.back")}</Button>
                <Button variant="hero" className="flex-1" size="lg" onClick={() => setStep(3)}>
                  {t("modal.continue")} <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <div className="text-center mb-4">
                <h2 className="font-display text-2xl font-bold">{t("modal.salesFunnel")}</h2>
                <p className="text-muted-foreground text-sm mt-1 max-w-sm mx-auto">{t("modal.salesFunnelDesc")}</p>
              </div>
              <div className="border border-border rounded-xl p-5 space-y-4">
                <div className="bg-muted rounded-lg p-4 text-center">
                  <p className="text-2xl font-display font-bold text-primary">{t("modal.salesFunnelSetup")}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t("modal.included")}</p>
                </div>
                <ul className="space-y-2">
                  {[t("modal.funnelFeature1"), t("modal.funnelFeature2"), t("modal.funnelFeature3"), t("modal.funnelFeature4"), t("modal.funnelFeature5")].map((item) => (
                    <li key={item} className="flex items-start gap-2 text-sm">
                      <Check className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                      <span className="text-secondary-foreground">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={() => setStep(2)}>{t("modal.back")}</Button>
                <Button variant="hero" className="flex-1" size="lg" onClick={() => setStep(4)}>
                  {t("modal.continue")} <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-5">
              <div className="text-center mb-4">
                <h2 className="font-display text-2xl font-bold">{t("modal.goGlobal")}</h2>
                <p className="text-muted-foreground text-sm mt-1 max-w-sm mx-auto">{t("modal.goGlobalDesc")}</p>
              </div>
              <div className="border border-border rounded-xl p-5 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t("modal.company")}</span>
                  <span className="font-medium text-foreground">{companyName}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t("modal.email")}</span>
                  <span className="font-medium text-foreground">{email}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t("modal.plan")}</span>
                  <span className="font-medium text-primary">{t("modal.planValue")}</span>
                </div>
              </div>
              <p className="text-center text-xs text-muted-foreground">{t("modal.noCreditCard")}</p>
              <div className="flex gap-3">
                <Button variant="outline" className="flex-1" onClick={() => setStep(3)}>{t("modal.back")}</Button>
                <Button variant="hero" className="flex-1" size="lg" onClick={handleSignUp} disabled={loading}>
                  {loading ? (
                    <><Loader2 className="w-4 h-4 animate-spin mr-1" />{t("modal.signingUp")}</>
                  ) : (
                    <>{t("modal.signUpBtn")} <ArrowRight className="w-4 h-4 ml-1" /></>
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default OnboardingModal;
