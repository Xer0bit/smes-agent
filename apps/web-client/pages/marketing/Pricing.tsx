import { Check, ArrowUpRight } from "lucide-react";
import { useLandingContext } from "@/contexts/LandingContext";
import "../../styles/pricing.css";

const tiers = [
  {
    name: "Starter",
    price: "$29",
    period: "/month",
    description: "For solo operators and small teams getting started.",
    features: ["Up to 50 agent runs/month", "Basic workflow templates", "Email support", "Single user"],
    cta: "Start free trial",
    featured: false,
  },
  {
    name: "Professional",
    price: "$99",
    period: "/month",
    description: "For growing businesses that need more capacity.",
    features: ["Up to 500 agent runs/month", "Advanced workflow builder", "Priority support", "Up to 5 team members", "Custom integrations"],
    cta: "Start free trial",
    featured: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "For organizations with advanced security and scale needs.",
    features: ["Unlimited agent runs", "Dedicated infrastructure", "24/7 support + SLA", "Unlimited team members", "SSO & advanced security", "Custom contracts"],
    cta: "Contact sales",
    featured: false,
  },
];

const comparison = [
  { feature: "Agent runs", starter: "50/month", pro: "500/month", enterprise: "Unlimited" },
  { feature: "Workflow templates", starter: "Basic", pro: "Advanced builder", enterprise: "Custom" },
  { feature: "Team members", starter: "1", pro: "Up to 5", enterprise: "Unlimited" },
  { feature: "Priority support", starter: false, pro: true, enterprise: true },
  { feature: "Custom integrations", starter: false, pro: true, enterprise: true },
  { feature: "SSO & advanced security", starter: false, pro: false, enterprise: true },
  { feature: "Dedicated infrastructure", starter: false, pro: false, enterprise: true },
  { feature: "SLA", starter: false, pro: false, enterprise: true },
];

const faqs = [
  { question: "Can I change plans later?", answer: "Yes. Upgrade or downgrade at any time from your account settings. Changes take effect on your next billing cycle." },
  { question: "Is there a free trial?", answer: "Yes. All paid plans come with a 14-day free trial. No credit card required to start." },
  { question: "What happens when I hit my agent run limit?", answer: "You'll be notified before you reach your limit. Once reached, you can upgrade your plan or wait for the next billing cycle. We never cut off active workflows mid-execution." },
];

function CellValue({ value }: { value: boolean | string }) {
  if (typeof value === "string") return <>{value}</>;
  if (value) return <Check size={16} />;
  return <span className="no"></span>;
}

export default function Pricing() {
  const { onLaunch } = useLandingContext();

  return (
    <>
      <section className="smes-price-hero">
        <div className="smes-site-page-hero__inner smes-site-reveal" style={{ textAlign: "center", justifyItems: "center" }}>
          <h1>Simple, transparent pricing.</h1>
          <p className="smes-site-page-hero__copy" style={{ textAlign: "center" }}>
            Start free. Scale as you grow. No hidden fees, no long-term contracts.
          </p>
        </div>
      </section>

      <section className="smes-price-tiers smes-site-reveal">
        <div className="smes-site-section__inner">
          <div className="smes-price-tiers__grid">
            {tiers.map(({ name, price, period, description, features, cta, featured }) => (
              <article className={`smes-price-card${featured ? " smes-price-card--featured" : ""}`} key={name}>
                {featured && <span className="smes-price-badge">Most Popular</span>}
                <h3>{name}</h3>
                <div className="smes-price-amount">
                  <strong>{price}</strong>
                  {period && <span>{period}</span>}
                </div>
                <p className="smes-price-card__desc">{description}</p>
                <ul className="smes-price-features">
                  {features.map((feature) => (
                    <li key={feature}>
                      <Check size={16} />
                      {feature}
                    </li>
                  ))}
                </ul>
                <button
                  className={`smes-site-button ${featured ? "smes-site-button--dark" : "smes-site-button--light"}`}
                  type="button"
                  onClick={onLaunch}
                  style={{ width: "100%" }}
                >
                  {cta}
                </button>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="smes-price-compare smes-site-reveal">
        <div className="smes-site-section__inner">
          <h2>Compare plans</h2>
          <div style={{ overflowX: "auto" }}>
            <table className="smes-price-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Starter</th>
                  <th>Professional</th>
                  <th>Enterprise</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map(({ feature, starter, pro, enterprise }) => (
                  <tr key={feature}>
                    <td>{feature}</td>
                    <td><CellValue value={starter} /></td>
                    <td><CellValue value={pro} /></td>
                    <td><CellValue value={enterprise} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="smes-price-faq smes-site-reveal">
        <div className="smes-site-section__inner">
          <div className="smes-price-faq__grid">
            <div className="smes-price-faq__header">
              <h2>Pricing questions.</h2>
            </div>
            <div className="smes-price-faq__list">
              {faqs.map(({ question, answer }) => (
                <details key={question}>
                  <summary>{question}</summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="smes-site-section smes-site-reveal" style={{ textAlign: "center", background: "radial-gradient(120% 90% at 50% 118%, var(--smes-site-glow-indigo) 0%, var(--smes-site-glow-violet) 38%, rgba(3,3,3,0) 68%), var(--smes-site-paper)" }}>
        <div className="smes-site-section__inner" style={{ textAlign: "center" }}>
          <h2 style={{ margin: 0, fontSize: "var(--smes-site-text-3xl)", fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1.1 }}>Ready to start?</h2>
          <p style={{ margin: "var(--smes-site-space-4) 0 0", color: "var(--smes-site-muted)", fontSize: "var(--smes-site-text-lg)" }}>Build your first system in minutes.</p>
          <div style={{ marginTop: "var(--smes-site-space-8)" }}>
            <button className="smes-site-button smes-site-button--dark" type="button" onClick={onLaunch}>
              Start building <ArrowUpRight aria-hidden="true" size={16} />
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
