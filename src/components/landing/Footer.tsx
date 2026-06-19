import { Link } from "react-router-dom";
import logoSrc from "@/assets/ecomgear-auth-logo.png";

const FOOTER_COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Features", to: "/features" },
      { label: "Agents", to: "/agents" },
      { label: "Pricing", to: "/pricing" },
      { label: "Contact", to: "/contact" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", to: "/features" },
      { label: "Privacy", to: "/privacy" },
      { label: "Terms", to: "/terms" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "eCG.ai", href: "https://ecomgear.ai" },
      { label: "Support", href: "mailto:info@ecomgear.dev" },
      { label: "Status", href: "https://ecomgear.ai" },
    ],
  },
  {
    title: "Language",
    links: [
      { label: "English", to: "/" },
      { label: "中文", to: "/" },
    ],
  },
];

export const Footer = () => {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="foot">
      <div className="foot__nav">
        <div>
          <div className="foot__logo">
            <img src={logoSrc} alt="ecomgear" className="foot__logo-img" />
          </div>
          <p className="foot__tagline">
            Autonomous storefront operations for brands launching globally and in China with one agent-driven workflow.
          </p>
        </div>

        <div className="foot__cols">
          {FOOTER_COLUMNS.map((column) => (
            <div key={column.title} className="foot__col">
              <div className="foot__col-title">{column.title}</div>
              {column.links.map((link) => (
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
          <span>© {currentYear} ecomgear. All rights reserved.</span>
          <a href="mailto:info@ecomgear.dev">info@ecomgear.dev</a>
        </div>
      </div>
    </footer>
  );
};
