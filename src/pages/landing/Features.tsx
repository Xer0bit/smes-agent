import { ArrowRight, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { Capabilities } from "@/components/landing/Capabilities";
import { DualPublish } from "@/components/landing/DualPublish";
import { LandingMarquee } from "@/components/landing/LandingMarquee";
import { TemplateGallery } from "@/components/landing/TemplateGallery";

export default function Features() {
  return (
    <>
      <section className="hero">
        <div className="hero__grid" />
        <div className="hero__inner">
          <div className="hero__eyebrow">
            <span className="hero__dot" />
            <Sparkles size={12} />
            PLATFORM OVERVIEW
          </div>
          <h1 className="hero__title">
            <span className="hero__title-line">Everything your storefront</span>
            <span className="hero__title-line hero__title-line--accent">needs to operate.</span>
          </h1>
          <p className="hero__sub">
            The same agent-led design language from the new home page now carries through the product story: templates, cross-border publishing, localization, and the operational backend that keeps brands shipping.
          </p>
          <div className="hero__cta">
            <Link to="/" className="btn btn--primary">
              Start with an agent
              <ArrowRight size={14} />
            </Link>
            <Link to="/pricing" className="btn btn--ghost">View pricing</Link>
          </div>
        </div>
      </section>
      <LandingMarquee />
      <DualPublish />
      <TemplateGallery />
      <Capabilities />
    </>
  );
}
