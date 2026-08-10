import { useTranslation } from "react-i18next";
import { Users, FileText, PieChart, ArrowRight, Target, Eye, MousePointerClick, UserCheck, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";

const LeadManagementSection = () => {
  const { t } = useTranslation();

  const journeySteps = [
    { step: "01", title: t("leads.brandAssets"), desc: t("leads.brandAssetsDesc") },
    { step: "02", title: t("leads.creativeDesign"), desc: t("leads.creativeDesignDesc") },
    { step: "03", title: t("leads.smartTargeting"), desc: t("leads.smartTargetingDesc") },
    { step: "04", title: t("leads.leadCapture"), desc: t("leads.leadCaptureDesc") },
    { step: "05", title: t("leads.qualification"), desc: t("leads.qualificationDesc") },
    { step: "06", title: t("leads.conversion"), desc: t("leads.conversionDesc") },
  ];

  const funnelStages = [
    { icon: Eye, label: t("leads.awareness"), desc: t("leads.awarenessDesc"), value: "10,000+", color: "from-blue-500 to-blue-600", width: "w-full" },
    { icon: MousePointerClick, label: t("leads.interest"), desc: t("leads.interestDesc"), value: "3,200", color: "from-indigo-500 to-indigo-600", width: "w-[85%]" },
    { icon: Target, label: t("leads.consideration"), desc: t("leads.considerationDesc"), value: "860", color: "from-violet-500 to-violet-600", width: "w-[65%]" },
    { icon: UserCheck, label: t("leads.intent"), desc: t("leads.intentDesc"), value: "320", color: "from-purple-500 to-purple-600", width: "w-[45%]" },
    { icon: ShoppingCart, label: t("leads.conversionStage"), desc: t("leads.conversionStageDesc"), value: "124", color: "from-primary to-primary", width: "w-[30%]" },
  ];

  const trafficSources = [
    { name: "Facebook Ads", percentage: 35 },
    { name: "LinkedIn Ads", percentage: 25 },
    { name: "Google Ads", percentage: 20 },
    { name: "Instagram Ads", percentage: 12 },
    { name: "YouTube Ads", percentage: 8 },
  ];

  const metrics = [
    { label: t("leads.dropOffRate"), value: "18%" },
    { label: t("leads.avgTime"), value: "4.2 days" },
    { label: t("leads.costPerLead"), value: "$12.40" },
    { label: t("leads.roi"), value: "340%" },
  ];

  const leadStats = [
    { icon: Users, value: "124", label: t("leads.totalLeads") },
    { icon: FileText, value: "38", label: t("leads.thisMonth") },
    { icon: PieChart, value: "67%", label: t("leads.conversionRate") },
  ];

  const mockLeads = [
    { name: "Sarah Chen", source: "Facebook Form", status: t("leads.new"), date: t("leads.today") },
    { name: "James Wilson", source: "Facebook Form", status: t("leads.contacted"), date: t("leads.yesterday") },
    { name: "Maria Lopez", source: "Facebook Form", status: t("leads.qualified"), date: t("leads.daysAgo", { count: 2 }) },
    { name: "Alex Kim", source: "Facebook Form", status: t("leads.new"), date: t("leads.daysAgo", { count: 3 }) },
  ];

  const statusColors: Record<string, string> = {
    [t("leads.new")]: "bg-primary/20 text-primary",
    [t("leads.contacted")]: "bg-blue-500/10 text-blue-600",
    [t("leads.qualified")]: "bg-green-500/10 text-green-600",
  };

  return (
    <section id="leads" className="py-24 px-4">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <span className="text-primary text-sm font-semibold uppercase tracking-widest font-body">{t("leads.badge")}</span>
          <h2 className="font-display text-4xl md:text-5xl font-bold mt-3 mb-4">
            {t("leads.title")} <span className="text-gradient-gold">{t("leads.titleHighlight")}</span>
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto font-body">
            {t("leads.subtitle")}
          </p>
        </div>

        <div className="bg-card border border-border rounded-xl p-6 mb-12">
          <h4 className="font-display font-semibold mb-6 text-foreground">{t("leads.customerJourney")}</h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {journeySteps.map((item, index) => (
              <div key={item.step} className="relative text-center">
                <div className="bg-primary/10 rounded-lg p-4">
                  <span className="text-xs font-bold text-primary font-display">{item.step}</span>
                  <p className="text-sm font-semibold font-body text-foreground mt-2">{item.title}</p>
                  <p className="text-xs text-muted-foreground font-body mt-1">{item.desc}</p>
                </div>
                {index < 5 && (
                  <div className="hidden md:block absolute top-1/2 -right-2 transform -translate-y-1/2">
                    <ArrowRight className="w-3 h-3 text-primary/50" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="grid lg:grid-cols-5 gap-6 mb-12">
          <div className="lg:col-span-3 bg-card border border-border rounded-xl p-6">
            <h4 className="font-display font-semibold mb-6 text-foreground">{t("leads.salesFunnel")}</h4>
            <div className="flex flex-col items-center gap-2">
              {funnelStages.map((stage, index) => (
                <div key={stage.label} className={`${stage.width} transition-all duration-300`}>
                  <div className={`bg-gradient-to-r ${stage.color} rounded-lg px-4 py-3 flex items-center justify-between text-white`}>
                    <div className="flex items-center gap-3">
                      <stage.icon className="w-4 h-4 shrink-0" />
                      <div>
                        <p className="text-sm font-semibold font-body">{stage.label}</p>
                        <p className="text-xs opacity-80 font-body hidden sm:block">{stage.desc}</p>
                      </div>
                    </div>
                    <span className="text-sm font-bold font-display">{stage.value}</span>
                  </div>
                  {index < funnelStages.length - 1 && (
                    <div className="flex justify-center py-1">
                      <div className="w-0 h-0 border-l-[8px] border-r-[8px] border-t-[8px] border-l-transparent border-r-transparent border-t-muted-foreground/30" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-2 bg-card border border-border rounded-xl p-6">
            <h4 className="font-display font-semibold mb-6 text-foreground">{t("leads.trafficSources")}</h4>
            <div className="space-y-4">
              {trafficSources.map((source) => (
                <div key={source.name}>
                  <div className="flex justify-between text-sm font-body mb-1">
                    <span className="text-foreground">{source.name}</span>
                    <span className="text-muted-foreground">{source.percentage}%</span>
                  </div>
                  <div className="w-full bg-secondary/50 rounded-full h-2">
                    <div className="bg-gradient-to-r from-primary to-primary/70 h-2 rounded-full transition-all duration-500" style={{ width: `${source.percentage}%` }} />
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 pt-6 border-t border-border">
              <h5 className="text-sm font-semibold font-body text-foreground mb-3">{t("leads.funnelMonitoring")}</h5>
              <div className="grid grid-cols-2 gap-3">
                {metrics.map((metric) => (
                  <div key={metric.label} className="bg-secondary/30 rounded-lg p-3 text-center">
                    <p className="text-lg font-bold font-display text-gradient-gold">{metric.value}</p>
                    <p className="text-xs text-muted-foreground font-body">{metric.label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="max-w-2xl mx-auto space-y-6">
          <div className="grid grid-cols-3 gap-4">
            {leadStats.map(({ icon: Icon, value, label }) => (
              <div key={label} className="bg-card border border-border rounded-xl p-4 text-center">
                <Icon className="w-5 h-5 text-primary mx-auto mb-2" />
                <p className="text-2xl font-display font-bold text-gradient-gold">{value}</p>
                <p className="text-muted-foreground text-xs font-body">{label}</p>
              </div>
            ))}
          </div>

          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-6 h-6 rounded bg-blue-600 flex items-center justify-center">
                <span className="text-xs font-bold text-white">f</span>
              </div>
              <span className="text-sm font-semibold font-body text-foreground">{t("leads.fbConnected")}</span>
            </div>
            <p className="text-muted-foreground text-sm font-body mb-4">{t("leads.fbDesc")}</p>
            <Button variant="hero" size="sm">
              {t("leads.connectFacebook")} <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
};

export default LeadManagementSection;
