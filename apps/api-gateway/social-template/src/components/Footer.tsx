import { useTranslation } from "react-i18next";
import { Share2 } from "lucide-react";

const Footer = () => {
  const { t } = useTranslation();

  return (
    <footer className="border-t border-border py-12 px-4">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
            <Share2 className="w-3.5 h-3.5 text-primary" />
          </div>
          <span className="font-display font-semibold text-sm">{t("footer.brand")}</span>
        </div>
        <p className="text-muted-foreground text-xs font-body">
          {t("footer.copyright", { year: new Date().getFullYear() })}
        </p>
      </div>
    </footer>
  );
};

export default Footer;
