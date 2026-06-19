import { useState } from "react";

interface PricingSectionProps {
  onPlanAction?: (planName: string) => void;
}

const PRICING = {
  monthly: [
    { name: "Starter", price: 0, cadence: "free", blurb: "Explore. Publish a single-market site with our branding.", features: ["1 storefront", "Global OR China", "Ecomgear subdomain", "Community support"], cta: "Start free", highlight: false },
    { name: "Business", price: 89, cadence: "/mo", blurb: "For SMEs shipping to both markets. Custom domains.", features: ["Unlimited storefronts", "Global + China dual-publish", "Custom domains · ICP filing", "WeChat Pay · Alipay · Stripe", "Agent runs 24/7"], cta: "Hire an agent", highlight: true },
    { name: "Scale", price: 349, cadence: "/mo", blurb: "Agencies & multi-brand operators. Team seats + API.", features: ["Everything in Business", "10 brands · 20 team seats", "Priority agent compute", "API + webhooks", "Dedicated success engineer"], cta: "Talk to sales", highlight: false },
  ],
  yearly: [
    { name: "Starter", price: 0, cadence: "free", blurb: "Explore. Publish a single-market site with our branding.", features: ["1 storefront", "Global OR China", "Ecomgear subdomain", "Community support"], cta: "Start free", highlight: false },
    { name: "Business", price: 71, cadence: "/mo, billed yearly", blurb: "For SMEs shipping to both markets. Custom domains.", features: ["Unlimited storefronts", "Global + China dual-publish", "Custom domains · ICP filing", "WeChat Pay · Alipay · Stripe", "Agent runs 24/7"], cta: "Hire an agent", highlight: true },
    { name: "Scale", price: 279, cadence: "/mo, billed yearly", blurb: "Agencies & multi-brand operators. Team seats + API.", features: ["Everything in Business", "10 brands · 20 team seats", "Priority agent compute", "API + webhooks", "Dedicated success engineer"], cta: "Talk to sales", highlight: false },
  ],
};

export function PricingSection({ onPlanAction }: PricingSectionProps) {
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly");
  const plans = PRICING[period];

  return (
    <section className="pricing" id="pricing">
      <div className="section-head">
        <div className="section-head__num">05</div>
        <div className="section-head__label">PRICING</div>
        <div className="section-head__spacer" />
      </div>
      <div className="pricing__head">
        <h2 className="section-title">
          Simple plans.<br />
          <span className="section-title__accent">No surprises.</span>
        </h2>
        <div className="pricing__toggle">
          <button
            className={`pricing__toggle-btn ${period === "monthly" ? "is-active" : ""}`}
            onClick={() => setPeriod("monthly")}
          >
            Monthly
          </button>
          <button
            className={`pricing__toggle-btn ${period === "yearly" ? "is-active" : ""}`}
            onClick={() => setPeriod("yearly")}
          >
            Yearly <span className="pricing__save-tag">Save 20%</span>
          </button>
        </div>
      </div>
      <div className="pricing__grid">
        {plans.map((p) => (
          <div key={p.name} className={`plan ${p.highlight ? "plan--highlight" : ""}`}>
            {p.highlight && <div className="plan__tag">Most popular</div>}
            <div className="plan__name">{p.name}</div>
            <div className="plan__price">
              {p.price === 0 ? (
                <span className="plan__num">$0</span>
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
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <path
                      d="M2 6.5L5 9L10 3"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {f}
                </li>
              ))}
            </ul>
            <button
              className={`plan__cta ${p.highlight ? "plan__cta--primary" : ""}`}
              onClick={() => onPlanAction?.(p.name)}
              type="button"
            >
              {p.cta}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
