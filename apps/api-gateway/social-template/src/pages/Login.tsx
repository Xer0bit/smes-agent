import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import logo from "@/assets/fgv-logo-blue.png";
import { toast } from "sonner";

const Login = () => {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    const { error } = await signIn(email, password);
    if (error) {
      toast.error(error.message);
    } else {
      navigate("/admin");
    }
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <a href="https://ft30.fgvexpo.com" className="inline-block">
            <img src={logo} alt="FT30 Media" className="w-12 h-12 mx-auto mb-4 object-contain" />
          </a>
          <h1 className="font-display text-2xl font-bold text-foreground">{t("loginPage.title")}</h1>
          <p className="text-muted-foreground text-sm font-body mt-1">{t("loginPage.subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email" className="font-body">{t("loginPage.email")}</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@ft30.com"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="font-body">{t("loginPage.password")}</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <Button type="submit" variant="hero" className="w-full" disabled={isLoading}>
            {isLoading ? t("loginPage.signingIn") : t("loginPage.signIn")}
          </Button>
        </form>

        <p className="text-center text-xs text-muted-foreground mt-6 font-body">
          <a href="/" className="hover:text-foreground transition-colors">{t("loginPage.backToWebsite")}</a>
        </p>
      </div>
    </div>
  );
};

export default Login;
