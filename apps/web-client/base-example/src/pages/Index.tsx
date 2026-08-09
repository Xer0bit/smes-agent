import { useState } from "react";
import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import MediaReachSection from "@/components/MediaReachSection";
import SocialMediaSection from "@/components/SocialMediaSection";
import LeadManagementSection from "@/components/LeadManagementSection";
import OnboardingSection from "@/components/OnboardingSection";
import Footer from "@/components/Footer";
import PricingSection from "@/components/PricingSection";
import OnboardingModal from "@/components/OnboardingModal";

const Index = () => {
  const [showOnboarding, setShowOnboarding] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <Navbar onStartTrial={() => setShowOnboarding(true)} />
      <HeroSection />
      <MediaReachSection />
      <SocialMediaSection />
      <LeadManagementSection />
      <PricingSection onStartTrial={() => setShowOnboarding(true)} />
      <OnboardingSection />
      <Footer />
      <OnboardingModal open={showOnboarding} onOpenChange={setShowOnboarding} />
    </div>
  );
};

export default Index;
