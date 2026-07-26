import { useTranslation } from "react-i18next";
import mediaBanner from "@/assets/media-banner.png";
import { Globe, Newspaper, TrendingUp } from "lucide-react";

const MediaReachSection = () => {
  const { t } = useTranslation();

  const stats = [
    { icon: Globe, stat: t("mediaReach.mediaOutletsCount"), label: t("mediaReach.mediaOutlets"), desc: t("mediaReach.mediaOutletsDesc") },
    { icon: Newspaper, stat: t("mediaReach.countriesCount"), label: t("mediaReach.countriesReached"), desc: t("mediaReach.countriesDesc") },
    { icon: TrendingUp, stat: t("mediaReach.readersCount"), label: t("mediaReach.monthlyReaders"), desc: t("mediaReach.readersDesc") },
  ];

  return (
    <section id="pr-wire" className="py-24 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <span className="text-primary text-sm font-semibold uppercase tracking-widest font-body">{t("mediaReach.badge")}</span>
          <h2 className="font-display text-4xl md:text-5xl font-bold mt-3 mb-4">
            {t("mediaReach.title")} <span className="text-gradient-gold">{t("mediaReach.titleHighlight")}</span>
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto font-body">
            {t("mediaReach.subtitle")}
          </p>
        </div>

        <div className="bg-card border border-glow rounded-2xl p-8 mb-12">
          <p className="text-muted-foreground text-sm text-center mb-6 font-body uppercase tracking-wider">{t("mediaReach.featuredIn")}</p>
          <img src={mediaBanner} alt="Media reach including Forbes, NBC, AP, Fox News, Digital Journal and more" className="w-full max-w-4xl mx-auto object-contain opacity-70" />
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {stats.map(({ icon: Icon, stat, label, desc }) => (
            <div key={label} className="bg-card border border-border rounded-xl p-6 text-center hover:border-glow transition-colors">
              <Icon className="w-8 h-8 text-primary mx-auto mb-3" />
              <p className="text-3xl font-display font-bold text-gradient-gold">{stat}</p>
              <p className="text-foreground font-semibold text-sm mt-1 font-body">{label}</p>
              <p className="text-muted-foreground text-xs mt-1 font-body">{desc}</p>
            </div>
          ))}
        </div>

        <div className="text-center mt-10">
          <p className="text-2xl md:text-3xl font-display font-bold text-gradient-gold">
            {t("mediaReach.geoSeo")}
          </p>
          <p className="text-muted-foreground text-sm md:text-base max-w-2xl mx-auto mt-3 font-body">
            {t("mediaReach.geoSeoDesc")}
          </p>
        </div>
      </div>
    </section>
  );
};

export default MediaReachSection;
