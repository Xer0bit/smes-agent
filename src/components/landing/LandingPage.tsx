import "../../styles/landing.css";
import { Header } from "@/components/landing/Header";
import { Footer } from "@/components/landing/Footer";
import { useLandingContext } from "@/contexts/LandingContext";
import { HeroSection } from "./HeroSection";
import { LandingMarquee } from "./LandingMarquee";
import { GlobalReach } from "./GlobalReach";
import { DualPublish } from "./DualPublish";
import { Capabilities } from "./Capabilities";
import { FaqSection } from "./FaqSection";

interface LandingPageProps {
  onLaunch: () => void;
}

export function LandingPage({ onLaunch }: LandingPageProps) {
  const { user, onLoginClick } = useLandingContext();

  return (
    <div className="ecg-landing">
      <Header onLoginClick={onLoginClick} user={user} />
      <HeroSection onLaunch={onLaunch} />
      <LandingMarquee />
      <GlobalReach />
      <DualPublish />
      <Capabilities />
      <FaqSection />
      <Footer />
    </div>
  );
}
