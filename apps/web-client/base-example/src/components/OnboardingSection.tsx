import { useTranslation } from "react-i18next";
import { Headset, Plug, Send, ShieldCheck } from "lucide-react";

const OnboardingSection = () => {
  const { t } = useTranslation();

  const steps = [
    { icon: ShieldCheck, title: t("onboarding.step1Title"), desc: t("onboarding.step1Desc") },
    { icon: Plug, title: t("onboarding.step2Title"), desc: t("onboarding.step2Desc") },
    { icon: Send, title: t("onboarding.step3Title"), desc: t("onboarding.step3Desc") },
    { icon: Headset, title: t("onboarding.step4Title"), desc: t("onboarding.step4Desc") },
  ];

  return (
    <section className="py-24 px-4 bg-surface-elevated">
      <div className="max-w-4xl mx-auto text-center">
        <span className="text-primary text-sm font-semibold uppercase tracking-widest font-body">{t("onboarding.badge")}</span>
        <h2 className="font-display text-4xl md:text-5xl font-bold mt-3 mb-4">
          {t("onboarding.title")} <span className="text-gradient-gold">{t("onboarding.titleHighlight")}</span>
        </h2>
        <p className="text-muted-foreground text-lg max-w-xl mx-auto mb-16 font-body">
          {t("onboarding.subtitle")}
        </p>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {steps.map(({ icon: Icon, title, desc }, i) => (
            <div key={title} className="relative bg-card border border-border rounded-xl p-6 text-center hover:border-glow transition-colors">
              <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center mx-auto mb-4">
                <span className="text-sm font-bold text-primary-foreground">{i + 1}</span>
              </div>
              <Icon className="w-6 h-6 text-primary mx-auto mb-3" />
              <h3 className="font-display font-semibold text-sm mb-2">{title}</h3>
              <p className="text-muted-foreground text-xs font-body">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default OnboardingSection;
