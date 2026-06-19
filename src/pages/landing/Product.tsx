import { ArrowRight, Sparkles, Code2, Mail, Globe, Cpu, Shield, Zap, Server, Network, Bot, Rocket, Lock, MonitorSmartphone } from "lucide-react";
import { Link } from "react-router-dom";
import { useLandingContext } from "@/contexts/LandingContext";

const STATS = [
  { num: "4,218", unit: "TH/s", label: "Network Compute Pool" },
  { num: "1,844", unit: "", label: "Active AI Agents" },
  { num: "12,690", unit: "", label: "VPN Credits Earned" },
];

const PRODUCTS = [
  {
    id: "ecgdev",
    icon: Code2,
    badge: "BUILD",
    name: "eCGDev",
    tagline: "AI-powered web development platform",
    description:
      "Go from idea to production website using natural language. AI agents generate code, build storefronts, and deploy globally — or into China — with a single click.",
    features: [
      "AI code generation from natural language prompts",
      "One-click deploy to Global + China CDN",
      "Role-based workspace with team permissions",
      "AI agents for content, SEO, and operations",
      "Template gallery with bilingual storefronts",
      "Real-time collaborative editor",
    ],
    accent: "var(--ecg-accent)",
  },
  {
    id: "onemail",
    icon: Mail,
    badge: "AUTOMATE",
    name: "OneMAIL",
    tagline: "AI email agent for every mailbox",
    description:
      "Attach an AI agent to every mailbox in your organization. It reads, categorizes, drafts, and follows up — across Gmail, Outlook, Exchange, and IMAP.",
    features: [
      "AI agent per mailbox — reads, drafts, and replies",
      "Gmail, Outlook, Exchange, and IMAP support",
      "Smart categorization and priority routing",
      "Follow-up tracking and escalation rules",
      "Multi-language email composition",
      "Audit trail for every automated action",
    ],
    accent: "#22c55e",
  },
  {
    id: "onenet",
    icon: Globe,
    badge: "CONNECT",
    name: "OneNET",
    tagline: "Global VPN & GPU compute infrastructure",
    description:
      "Secure cross-border connectivity with VPN nodes across HK, CN, SG, US, and EU. Contribute idle compute for GPU inference and earn VPN credits.",
    features: [
      "Global VPN with HK · CN · SG · US · EU nodes",
      "GPU computing marketplace for AI inference",
      "Idle CPU → AI Inference → VPN Credits loop",
      "WireGuard-based secure tunnels",
      "Cross-border data compliance (ICP Licensed)",
      "Game streaming & low-latency relay",
    ],
    accent: "#a78bfa",
  },
];

const SPECS = [
  { label: "VPN Protocol", value: "WireGuard", icon: Shield },
  { label: "AI Models", value: "Claude · Gemini", icon: Bot },
  { label: "Vector Store", value: "Pinecone", icon: Server },
  { label: "Compute", value: "KVM / QEMU", icon: Cpu },
  { label: "Streaming", value: "Game Relay", icon: MonitorSmartphone },
  { label: "China License", value: "ICP Licensed", icon: Lock },
  { label: "PoPs", value: "HK · CN · SG · US · EU", icon: Network },
  { label: "Latency", value: "HKG→SZX 80ms", icon: Zap },
];

export default function Product() {
  const { onLoginClick, user } = useLandingContext();

  return (
    <>
      {/* ── Hero ── */}
      <section className="hero">
        <div className="hero__grid" />
        <div className="hero__inner">
          <h1 className="hero__title">
            <span className="hero__title-line">Accelerate SME</span>
            <span className="hero__title-line hero__title-line--accent">Digital to AI Transformation.</span>
          </h1>
          <p className="hero__sub">
            Build, connect, and operate on a single AI-powered platform designed
            for small-to-medium enterprises crossing borders between China and
            the rest of the world.
          </p>
          <div className="hero__cta">
            {user ? (
              <Link to="/dashboard" className="btn btn--primary">
                Go to Dashboard <ArrowRight size={14} />
              </Link>
            ) : (
              <button className="btn btn--primary" onClick={onLoginClick} type="button">
                Start building <ArrowRight size={14} />
              </button>
            )}
            <Link to="/pricing" className="btn btn--ghost">View plans</Link>
          </div>

          {/* Stats bar */}
          <div className="hero__meta">
            {STATS.map((s, i) => (
              <span key={s.label} className="contents">
                {i > 0 && <span className="hero__meta-divider" />}
                <span className="hero__meta-item">
                  <span className="hero__meta-num">
                    {s.num}
                    {s.unit && <span style={{ fontSize: 14, opacity: 0.5, marginLeft: 4 }}>{s.unit}</span>}
                  </span>
                  <span className="hero__meta-label">{s.label}</span>
                </span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Compute flow strip ── */}
      <div className="prod-flow">
        <div className="prod-flow__inner">
          <span className="prod-flow__node">
            <Cpu size={14} /> Idle CPU
          </span>
          <span className="prod-flow__arrow">→</span>
          <span className="prod-flow__node prod-flow__node--accent">
            <Bot size={14} /> AI Inference
          </span>
          <span className="prod-flow__arrow">→</span>
          <span className="prod-flow__node">
            <Globe size={14} /> VPN Credits
          </span>
        </div>
      </div>

      {/* ── Three product modules ── */}
      <section className="prod-modules">
        <div className="section-head">
          <span className="section-head__num">01</span>
          OUR PRODUCTS
          <span className="section-head__spacer" />
        </div>
        <div className="prod-modules__inner">
          {PRODUCTS.map((p) => {
            const Icon = p.icon;
            return (
              <article key={p.id} className="prod-card" id={p.id}>
                <div className="prod-card__header">
                  <span className="prod-card__badge" style={{ color: p.accent }}>
                    <Icon size={14} />
                    {p.badge}
                  </span>
                  <h2 className="prod-card__name">{p.name}</h2>
                  <p className="prod-card__tagline">{p.tagline}</p>
                </div>
                <p className="prod-card__desc">{p.description}</p>
                <ul className="prod-card__features">
                  {p.features.map((f) => (
                    <li key={f}>
                      <Rocket size={12} style={{ color: p.accent, flexShrink: 0 }} />
                      {f}
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      </section>

      {/* ── Under the Hood ── */}
      <section className="prod-specs">
        <div className="section-head">
          <span className="section-head__num">02</span>
          UNDER THE HOOD
          <span className="section-head__spacer" />
        </div>
        <div className="prod-specs__inner">
          <div className="prod-specs__headline">
            <h2 className="section-title">
              Built on proven<br />
              <span className="section-title__accent">infrastructure.</span>
            </h2>
            <p className="section-sub">
              Every layer of the stack is chosen for reliability, compliance, and
              sub-second performance across the China firewall.
            </p>
          </div>
          <div className="prod-specs__grid">
            {SPECS.map((s) => {
              const Icon = s.icon;
              return (
                <div key={s.label} className="prod-spec">
                  <Icon size={16} className="prod-spec__icon" />
                  <span className="prod-spec__value">{s.value}</span>
                  <span className="prod-spec__label">{s.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </>
  );
}
