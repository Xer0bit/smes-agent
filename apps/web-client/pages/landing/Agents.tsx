import { Link } from "react-router-dom";
import { ArrowRight, Sparkles, BookOpenCheck, BriefcaseBusiness, CalendarClock, Database, Headset, Megaphone, TrendingUp, Rocket } from "lucide-react";
import { useLandingContext } from "@/contexts/LandingContext";

const AGENTS = [
  {
    icon: BookOpenCheck,
    name: "Book Keeper Assistant",
    tagline: "Keep finance records clean and always up to date.",
    highlights: [
      "Daily expense capture and categorization",
      "Invoice and payment follow-up reminders",
      "Monthly close checklist support",
    ],
    accent: "var(--ecg-accent)",
  },
  {
    icon: Megaphone,
    name: "Social Media Executive",
    tagline: "Plan, draft, and schedule campaigns with a single workflow.",
    highlights: [
      "Weekly content calendar drafts",
      "Post ideas based on current offers",
      "Campaign recap and next-step suggestions",
    ],
    accent: "#22c55e",
  },
  {
    icon: TrendingUp,
    name: "Sales Executive",
    tagline: "Convert leads faster with consistent follow-up.",
    highlights: [
      "Lead qualification prompts and scripts",
      "Quote and proposal follow-up sequencing",
      "Pipeline movement nudges for each deal",
    ],
    accent: "#f59e0b",
  },
  {
    icon: Headset,
    name: "Customer Service Executive",
    tagline: "Deliver fast, reliable responses across customer touchpoints.",
    highlights: [
      "Priority queue for urgent customer requests",
      "Response templates for common cases",
      "Escalation handoff with full conversation context",
    ],
    accent: "#a78bfa",
  },
  {
    icon: CalendarClock,
    name: "Personal Assistant (OneMAIL)",
    tagline: "Stay on top of inbox, meetings, and daily priorities.",
    highlights: [
      "Inbox summaries and action items",
      "Meeting prep briefs and reminders",
      "Task follow-up tracking by priority",
    ],
    accent: "#fb923c",
  },

  {
    icon: BriefcaseBusiness,
    name: "Business Development Manager",
    tagline: "Grow partnerships and uncover new revenue opportunities.",
    highlights: [
      "Partner outreach list and cadence",
      "Opportunity scoring and qualification",
      "Weekly growth review summaries",
    ],
    accent: "var(--ecg-accent)",
  },
];

export default function Agents() {
  const { onLoginClick, user } = useLandingContext();

  return (
    <>
      {/* Hero */}
      <section className="hero">
        <div className="hero__grid" />
        <div className="hero__inner">
          <h1 className="hero__title">
            <span className="hero__title-line">Meet your business-ready</span>
            <span className="hero__title-line hero__title-line--accent">AI agent team.</span>
          </h1>
          <p className="hero__sub">
            Choose the role you need, launch quickly, and let every agent focus on a clear business outcome from day one.
          </p>
          <div className="hero__cta">
            {user ? (
              <Link to="/dashboard/agents" className="btn btn--primary">
                Manage agents <ArrowRight size={14} />
              </Link>
            ) : (
              <button className="btn btn--primary" onClick={onLoginClick} type="button">
                Start with an agent <ArrowRight size={14} />
              </button>
            )}
            <Link to="/pricing" className="btn btn--ghost">View plans</Link>
          </div>
        </div>
      </section>

      {/* Agent Grid */}
      <section className="agents-section">
        <div className="section-head">
          <span className="section-head__num">01</span>
          AVAILABLE ROLES
          <span className="section-head__spacer" />
        </div>
        <div className="agents-grid">
          {AGENTS.map(({ icon: Icon, name, tagline, highlights, accent }) => (
            <article key={name} className="agent-card">
              <div className="agent-card__icon" style={{ background: `color-mix(in oklch, ${accent} 12%, transparent)`, color: accent }}>
                <Icon size={18} />
              </div>
              <h2 className="agent-card__name">{name}</h2>
              <p className="agent-card__tagline">{tagline}</p>
              <ul className="agent-card__list">
                {highlights.map((item) => (
                  <li key={item}>
                    <Rocket size={11} style={{ color: accent, flexShrink: 0 }} />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="agents-cta">
        <div className="agents-cta__inner">
          <h3 className="agents-cta__title">Build your agent lineup in minutes</h3>
          <p className="agents-cta__sub">
            Start with one role or deploy a full team and scale your operations with confidence.
          </p>
          <div className="agents-cta__actions">
            <Link to="/pricing" className="btn btn--primary">
              View Plans <ArrowRight size={14} />
            </Link>
            <Link to="/" className="btn btn--ghost">
              Back to Home
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}