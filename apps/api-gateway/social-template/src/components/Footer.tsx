import { useTranslation } from "react-i18next";
import logo from "@/assets/fgv-logo-blue.png";

const Footer = () => {
  const { t } = useTranslation();

  return (
    <footer className="border-t border-border py-12 px-4">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-3">
          <img src={logo} alt="FGV" className="w-6 h-6 object-contain" />
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
