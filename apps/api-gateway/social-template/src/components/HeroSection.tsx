import { useTranslation } from "react-i18next";
import { Share2 } from "lucide-react";

const HeroSection = () => {
  const { t } = useTranslation();

  return (
    <section className="relative flex items-center justify-center overflow-hidden px-4 pt-24 pb-8">
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-primary/3 blur-[120px]" />

      <div className="relative z-10 max-w-5xl mx-auto text-center">
        <div className="w-24 h-24 mx-auto mb-8 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Share2 className="w-10 h-10 text-primary" />
        </div>

        <h1 className="font-display text-5xl md:text-7xl font-bold tracking-tight mb-6">
          <span className="text-gradient-gold">{t("hero.title1")}</span>{" "}
          <span className="text-foreground">{t("hero.title2")}</span>
          <br />
          <span className="text-foreground">{t("hero.title3")}</span>
        </h1>

        <p className="text-muted-foreground text-lg md:text-xl max-w-2xl mx-auto font-body">
          {t("hero.subtitle")}
        </p>
      </div>
    </section>
  );
};

export default HeroSection;
