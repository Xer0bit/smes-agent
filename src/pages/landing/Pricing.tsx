import { useState } from "react";
import { Check } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { FaqSection } from "@/components/landing-v2/FaqSection";
import { useLandingContext } from "@/contexts/LandingContext";

const PLANS = {
  monthly: [
    {
      name: "Free",
      price: 0,
      cadence: "free forever",
      blurb: "Explore the platform. Build your first site with AI.",
      features: [
        "1 project",
        "1 seat",
        "10 ecos / month",
        "30 publish lines / month",
        "AI agent access",
        "Hosting included",
        "ecomgear subdomain",
        "Community support",
      ],
      cta: "Start free",
      highlight: false,
    },
    {
      name: "Starter",
      price: 9.99,
      cadence: "/mo",
      blurb: "For creators and small teams shipping real projects.",
      features: [
        "5 projects",
        "3 seats",
        "100 ecos / month",
        "30 publish lines / month",
        "Custom domains",
        "Export code",
        "Invite editors",
        "Ali Cloud integration",
        "ecomgear Cloud hosting",
        "Integration apps",
      ],
      cta: "Get started",
      highlight: false,
    },
    {
      name: "Professional",
      price: 49,
      cadence: "/mo",
      blurb: "For growing businesses publishing across markets.",
      features: [
        "Unlimited projects",
        "10 seats",
        "100 ecos / month",
        "100 publish lines / month",
        "Remove ecomgear branding",
        "Analytics dashboard",
        "API access",
        "Auto Pilot agent mode",
        "All Starter features",
      ],
      cta: "Go Pro",
      highlight: true,
    },
    {
      name: "Enterprise",
      price: -1,
      cadence: "custom",
      blurb: "For agencies and multi-brand operators at scale.",
      features: [
        "Unlimited seats",
        "Unlimited projects",
        "Priority support & SLA",
        "SSO / SAML",
        "Invite clients",
        "Client markup billing",
        "Dedicated success engineer",
        "All Professional features",
      ],
      cta: "Talk to sales",
      highlight: false,
    },
  ],
  yearly: [
    {
      name: "Free",
      price: 0,
      cadence: "free forever",
      blurb: "Explore the platform. Build your first site with AI.",
      features: [
        "1 project",
        "1 seat",
        "10 ecos / month",
        "30 publish lines / month",
        "AI agent access",
        "Hosting included",
        "ecomgear subdomain",
        "Community support",
      ],
      cta: "Start free",
      highlight: false,
    },
    {
      name: "Starter",
      price: 7.99,
      cadence: "/mo, billed yearly",
      blurb: "For creators and small teams shipping real projects.",
      features: [
        "5 projects",
        "3 seats",
        "100 ecos / month",
        "30 publish lines / month",
        "Custom domains",
        "Export code",
        "Invite editors",
        "Ali Cloud integration",
        "ecomgear Cloud hosting",
        "Integration apps",
      ],
      cta: "Get started",
      highlight: false,
    },
    {
      name: "Professional",
      price: 39,
      cadence: "/mo, billed yearly",
      blurb: "For growing businesses publishing across markets.",
      features: [
        "Unlimited projects",
        "10 seats",
        "100 ecos / month",
        "100 publish lines / month",
        "Remove ecomgear branding",
        "Analytics dashboard",
        "API access",
        "Auto Pilot agent mode",
        "All Starter features",
      ],
      cta: "Go Pro",
      highlight: true,
    },
    {
      name: "Enterprise",
      price: -1,
      cadence: "custom",
      blurb: "For agencies and multi-brand operators at scale.",
      features: [
        "Unlimited seats",
        "Unlimited projects",
        "Priority support & SLA",
        "SSO / SAML",
        "Invite clients",
        "Client markup billing",
        "Dedicated success engineer",
        "All Professional features",
      ],
      cta: "Talk to sales",
      highlight: false,
    },
  ],
};

export default function Pricing() {
  const { user, onLoginClick } = useLandingContext();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly");
  const plans = PLANS[period];

  const handlePlanAction = (planName: string) => {
    if (planName === "Enterprise") {
      navigate("/contact");
      return;
    }
    if (user) {
      navigate("/dashboard/settings");
    } else {
      onLoginClick();
    }
  };

  return (
    <>
      {/* Pricing grid */}
      <section className="pricing" id="pricing">
        <div className="pricing__head">
          <div />
          <div className="pricing__toggle">
            <button
              className={`pricing__toggle-btn ${period === "monthly" ? "is-active" : ""}`}
              onClick={() => setPeriod("monthly")}
              type="button"
            >
              Monthly
            </button>
            <button
              className={`pricing__toggle-btn ${period === "yearly" ? "is-active" : ""}`}
              onClick={() => setPeriod("yearly")}
              type="button"
            >
              Yearly <span className="pricing__save-tag">Save 20%</span>
            </button>
          </div>
        </div>
        <div className="pricing__grid pricing__grid--4">
          {plans.map((p) => (
            <div key={p.name} className={`plan ${p.highlight ? "plan--highlight" : ""}`}>
              {p.highlight && <div className="plan__tag">Most popular</div>}
              <div className="plan__name">{p.name}</div>
              <div className="plan__price">
                {p.price === 0 ? (
                  <span className="plan__num">$0</span>
                ) : p.price === -1 ? (
                  <span className="plan__num" style={{ fontSize: 36 }}>Custom</span>
                ) : (
                  <>
                    <span className="plan__currency">$</span>
                    <span className="plan__num">{p.price}</span>
                  </>
                )}
                <span className="plan__cadence">{p.cadence}</span>
              </div>
              <div className="plan__blurb">{p.blurb}</div>
              <ul className="plan__features">
                {p.features.map((f) => (
                  <li key={f}>
                    <Check size={12} />
                    {f}
                  </li>
                ))}
              </ul>
              <button
                className={`plan__cta ${p.highlight ? "plan__cta--primary" : ""}`}
                onClick={() => handlePlanAction(p.name)}
                type="button"
              >
                {p.cta}
              </button>
            </div>
          ))}
        </div>
      </section>

      <FaqSection />
    </>
  );
}
