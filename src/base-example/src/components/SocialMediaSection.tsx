import { useTranslation } from "react-i18next";
import { Calendar, BarChart3, Share2, Zap } from "lucide-react";
import mediaIcons from "@/assets/media-icons.png";

const SocialMediaSection = () => {
  const { t } = useTranslation();

  const features = [
    { icon: Calendar, title: t("social.schedulePublish"), desc: t("social.schedulePublishDesc") },
    { icon: BarChart3, title: t("social.analyticsInsights"), desc: t("social.analyticsInsightsDesc") },
    { icon: Share2, title: t("social.crossPost"), desc: t("social.crossPostDesc") },
    { icon: Zap, title: t("social.platformConnectors"), desc: t("social.platformConnectorsDesc") },
  ];

  return (
    <section id="social" className="py-24 px-4 bg-surface-elevated">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <span className="text-primary text-sm font-semibold uppercase tracking-widest font-body">{t("social.badge")}</span>
          <h2 className="font-display text-4xl md:text-5xl font-bold mt-3 mb-4">
            {t("social.title")} <span className="text-gradient-gold">{t("social.titleHighlight")}</span>
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto font-body">
            {t("social.subtitle")}
          </p>
        </div>

        <div className="flex justify-center mb-12">
          <img src={mediaIcons} alt="LinkedIn, Instagram, Facebook, X, YouTube" className="w-full max-w-md mx-auto" />
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {features.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="bg-card border border-border rounded-xl p-6 hover:border-glow transition-colors group">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/20 transition-colors">
                <Icon className="w-5 h-5 text-primary" />
              </div>
              <h3 className="font-display text-lg font-semibold mb-2">{title}</h3>
              <p className="text-muted-foreground text-sm font-body">{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default SocialMediaSection;
