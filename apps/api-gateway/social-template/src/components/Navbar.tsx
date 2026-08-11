import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Globe, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";

interface NavbarProps {
  onStartTrial?: () => void;
}

const languages = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
];

const Navbar = ({ onStartTrial }: NavbarProps) => {
  const { t, i18n } = useTranslation();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
      <div className="max-w-6xl mx-auto flex items-center justify-between px-4 h-16">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Share2 className="w-4 h-4 text-primary" />
          </div>
          <span className="font-display font-bold text-lg">Agency Dashboard</span>
        </div>

        <div className="hidden md:flex items-center gap-6">
          <a href="#pr-wire" className="text-sm text-muted-foreground hover:text-foreground transition-colors font-body">{t("nav.globalPress")}</a>
          <a href="#social" className="text-sm text-muted-foreground hover:text-foreground transition-colors font-body">{t("nav.socialMedia")}</a>
          <a href="#leads" className="text-sm text-muted-foreground hover:text-foreground transition-colors font-body">{t("nav.leads")}</a>
        </div>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="text-muted-foreground">
                <Globe className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {languages.map((lang) => (
                <DropdownMenuItem
                  key={lang.code}
                  onClick={() => i18n.changeLanguage(lang.code)}
                  className={i18n.language === lang.code ? "bg-primary text-primary-foreground focus:bg-primary focus:text-primary-foreground" : ""}
                >
                  {lang.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="sm" className="text-muted-foreground" asChild>
            <Link to="/login">{t("nav.login")}</Link>
          </Button>
          <Button variant="hero" size="sm" onClick={onStartTrial}>{t("nav.startFreeTrial")}</Button>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
