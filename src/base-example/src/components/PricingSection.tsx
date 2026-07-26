import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";

interface PricingSectionProps {
  onStartTrial?: () => void;
}

const PricingSection = ({ onStartTrial }: PricingSectionProps) => {
  const { t } = useTranslation();

  const features = [
    t("pricing.feature1"),
    t("pricing.feature2"),
    t("pricing.feature3"),
    t("pricing.feature4"),
    t("pricing.feature5"),
  ];

  return (
    <section id="pricing" className="py-24 px-4">
      <div className="max-w-5xl mx-auto text-center">
        <span className="text-primary text-sm font-semibold uppercase tracking-widest font-body">{t("pricing.badge")}</span>
        <h2 className="font-display text-4xl md:text-5xl font-bold mt-3 mb-4">
          {t("pricing.title")} <span className="text-gradient-gold">{t("pricing.titleHighlight")}</span> {t("pricing.titleEnd")}
        </h2>
        <p className="text-muted-foreground text-lg max-w-2xl mx-auto mb-12 font-body">
          {t("pricing.subtitle")}
        </p>

        <div className="inline-flex flex-col items-center bg-card border border-glow rounded-2xl p-8 shadow-gold">
          <div className="flex items-baseline gap-3 mb-2">
            <span className="text-muted-foreground line-through text-2xl font-body">{t("pricing.originalPrice")}</span>
            <span className="text-gradient-gold text-5xl font-display font-bold">{t("pricing.price")}</span>
            <span className="text-muted-foreground font-body">{t("pricing.perMonth")}</span>
          </div>
          <p className="text-primary text-sm font-semibold mb-4">{t("pricing.limitedTime")}</p>
          <ul className="text-left space-y-2 mb-6">
            {features.map((item) => (
              <li key={item} className="flex items-center gap-2 text-secondary-foreground text-sm font-body">
                <Check className="w-4 h-4 text-primary flex-shrink-0" />
                {item}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs font-body mb-6 text-left leading-relaxed">
            {t("pricing.adFees")}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 w-full">
            <Button variant="hero" size="lg" className="flex-1 text-base" onClick={onStartTrial}>
              {t("pricing.startFreeTrial")}
            </Button>
            <Button variant="hero-outline" size="lg" className="flex-1 text-base" onClick={onStartTrial}>
              {t("pricing.bookDemo")}
            </Button>
          </div>
        </div>

        <p className="text-muted-foreground text-xs font-body mt-6">
          {t("pricing.riskFree")}
        </p>
      </div>
    </section>
  );
};

export default PricingSection;
