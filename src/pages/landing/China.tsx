import { ArrowRight, Sparkles, Globe, Shield, Server, Wifi, CreditCard, FileCheck, ShoppingCart, MessageCircle, Truck, Building2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useLandingContext } from "@/contexts/LandingContext";

const BRIDGES = [
  {
    icon: Globe,
    title: "Cross-Border CDN",
    desc: "Deploy websites and storefronts simultaneously to global and China CDN with ICP-licensed hosting — no separate infrastructure needed.",
  },
  {
    icon: Shield,
    title: "VPN & Secure Tunnels",
    desc: "WireGuard-based nodes in HK, SG, and mainland China ensure your team and customers stay connected with sub-100ms latency.",
  },
  {
    icon: CreditCard,
    title: "WeChat Pay & Alipay",
    desc: "Built-in payment gateway integration for WeChat Pay, Alipay, and UnionPay alongside Stripe and PayPal for global customers.",
  },
  {
    icon: MessageCircle,
    title: "WeChat & Mini Programs",
    desc: "Publish storefronts as WeChat Mini Programs and connect customer service bots directly into WeChat Official Accounts.",
  },
  {
    icon: FileCheck,
    title: "ICP & Compliance",
    desc: "Our China infrastructure is ICP licensed. We handle filing, DNS routing, and content compliance so you can focus on your business.",
  },
  {
    icon: Truck,
    title: "Cross-Border Logistics",
    desc: "Integrate with major Chinese logistics providers (SF Express, Cainiao, JD Logistics) and global carriers from a single dashboard.",
  },
];

const MARKETS = [
  { flag: "🇭🇰", name: "Hong Kong", role: "Gateway Hub" },
  { flag: "🇨🇳", name: "Mainland China", role: "ICP Licensed" },
  { flag: "🇸🇬", name: "Singapore", role: "SEA Node" },
  { flag: "🇺🇸", name: "United States", role: "Americas" },
  { flag: "🇪🇺", name: "Europe", role: "GDPR Zone" },
];

const USECASES = [
  {
    icon: ShoppingCart,
    title: "E-Commerce Brands",
    desc: "Sell to Chinese consumers with a localized .cn storefront, WeChat integration, and local payment — while running your global store on the same platform.",
  },
  {
    icon: Building2,
    title: "B2B & Trading Companies",
    desc: "Connect suppliers in Shenzhen and Guangzhou to buyers worldwide. AI agents handle RFQs, translate specs, and track shipments in real time.",
  },
  {
    icon: Server,
    title: "SaaS & Tech Companies",
    desc: "Serve Chinese customers without a separate China stack. Our ICP-licensed CDN and compliant deployment pipeline handles the infrastructure.",
  },
];

export default function China() {
  const { onLoginClick, user } = useLandingContext();

  return (
    <>
      {/* ── Hero ── */}
      <section className="hero">
        <div className="hero__grid" />
        <div className="hero__inner">
          <h1 className="hero__title">
            <span className="hero__title-line">Bridge your business</span>
            <span className="hero__title-line hero__title-line--accent">into and out of China.</span>
          </h1>
          <p className="hero__sub">
            One platform that handles ICP compliance, WeChat integration,
            cross-border payments, and bilingual storefronts — so you can reach
            1.4 billion consumers without building a separate China stack.
          </p>
          <div className="hero__cta">
            {user ? (
              <Link to="/dashboard" className="btn btn--primary">
                Go to Dashboard <ArrowRight size={14} />
              </Link>
            ) : (
              <button className="btn btn--primary" onClick={onLoginClick} type="button">
                Get started <ArrowRight size={14} />
              </button>
            )}
            <Link to="/contact" className="btn btn--ghost">Talk to our China team</Link>
          </div>
        </div>
      </section>

      {/* ── Market Presence ── */}
      <div className="china-markets">
        <div className="china-markets__inner">
          {MARKETS.map((m) => (
            <div key={m.name} className="china-markets__node">
              <span className="china-markets__flag">{m.flag}</span>
              <span className="china-markets__name">{m.name}</span>
              <span className="china-markets__role">{m.role}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Bridge Capabilities ── */}
      <section className="china-bridges">
        <div className="section-head">
          <span className="section-head__num">01</span>
          HOW WE CONNECT
          <span className="section-head__spacer" />
        </div>
        <div className="china-bridges__headline">
          <h2 className="section-title">
            Everything you need to<br />
            <span className="section-title__accent">operate cross-border.</span>
          </h2>
          <p className="section-sub">
            From network infrastructure to payment rails, every piece is
            designed for businesses that move between China and the world.
          </p>
        </div>
        <div className="china-bridges__grid">
          {BRIDGES.map((b) => {
            const Icon = b.icon;
            return (
              <article key={b.title} className="china-bridge">
                <div className="china-bridge__icon">
                  <Icon size={18} />
                </div>
                <h3 className="china-bridge__title">{b.title}</h3>
                <p className="china-bridge__desc">{b.desc}</p>
              </article>
            );
          })}
        </div>
      </section>

      {/* ── Use Cases ── */}
      <section className="china-cases">
        <div className="section-head">
          <span className="section-head__num">02</span>
          WHO IT&apos;S FOR
          <span className="section-head__spacer" />
        </div>
        <div className="china-cases__inner">
          <div className="china-cases__headline">
            <h2 className="section-title">
              Built for businesses<br />
              <span className="section-title__accent">that cross borders.</span>
            </h2>
          </div>
          <div className="china-cases__cards">
            {USECASES.map((u) => {
              const Icon = u.icon;
              return (
                <article key={u.title} className="china-case">
                  <Icon size={20} className="china-case__icon" />
                  <h3 className="china-case__title">{u.title}</h3>
                  <p className="china-case__desc">{u.desc}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="china-cta">
        <div className="china-cta__inner">
          <div className="china-cta__eyebrow">
            <Wifi size={12} />
            READY TO CONNECT
          </div>
          <h2 className="china-cta__title">
            Start reaching Chinese customers today.
          </h2>
          <p className="china-cta__sub">
            Launch a bilingual storefront, integrate WeChat Pay, and deploy on
            our ICP-licensed China CDN — all from your existing ecomgear workspace.
          </p>
          <div className="china-cta__actions">
            {user ? (
              <Link to="/dashboard" className="btn btn--primary">
                Open Dashboard <ArrowRight size={14} />
              </Link>
            ) : (
              <button className="btn btn--primary" onClick={onLoginClick} type="button">
                Create account <ArrowRight size={14} />
              </button>
            )}
            <Link to="/pricing" className="btn btn--ghost">View pricing plans</Link>
          </div>
        </div>
      </section>
    </>
  );
}
