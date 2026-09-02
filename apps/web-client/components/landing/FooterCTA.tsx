import { Mail } from "lucide-react";
import { Link } from "react-router-dom";
import { useState } from "react";
import logoSrc from "@/assets/ecomgear-auth-logo.png";

const NAV_COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Features", to: "/features" },
      { label: "Templates", href: "#templates" },
      { label: "China publish", href: "#china" },
      { label: "Pricing", to: "/pricing" },
      { label: "FAQ", href: "#faq" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", to: "/features" },
      { label: "Contact", to: "/contact" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Docs", to: "/features" },
      { label: "API reference", to: "/features" },
      { label: "Status", href: "https://ecomgear.ai" },
      { label: "Community", href: "mailto:info@ecomgear.dev" },
    ],
  },
  {
    heading: "Language",
    links: [
      { label: "English", to: "/" },
      { label: "中文", to: "/" },
    ],
  },
];

export function FooterCTA() {
  const [email, setEmail] = useState("");

  return (
    <footer className="foot">
      <div className="foot__inner">
        <h2 className="foot__title">
          Ready to sell <span className="foot__title-accent">everywhere?</span>
        </h2>
        <div className="foot__cta">
          <form className="foot__input" onSubmit={(e) => { e.preventDefault(); }}>
            <Mail size={16} />
            <input
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button className="btn btn--primary" type="submit">Get early access</button>
          </form>
          <div className="foot__note">From $19/month · 1 App · 1 Agent · cancel anytime</div>
        </div>

        <div className="foot__nav">
          <div>
            <div className="foot__logo">
              <img src={logoSrc} alt="ecomgear" className="foot__logo-img" />
            </div>
            <div className="foot__tagline">
              One autonomous operator for design, localization, publishing, and storefront operations across global and China channels.
            </div>
          </div>

          <div className="foot__cols">
            {NAV_COLUMNS.map((col) => (
              <div key={col.heading} className="foot__col">
                <div className="foot__col-title">{col.heading}</div>
                {col.links.map((link) => (
                  link.to ? (
                    <Link key={link.label} to={link.to}>{link.label}</Link>
                  ) : (
                    <a key={link.label} href={link.href}>{link.label}</a>
                  )
                ))}
              </div>
            ))}
          </div>

          <div className="foot__bottom">
            <span>© {new Date().getFullYear()} ecomgear</span>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
