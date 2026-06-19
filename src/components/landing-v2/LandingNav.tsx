import { Link } from "react-router-dom";
import logoSrc from "@/assets/ecomgear-auth-logo.png";

const NAV_LINKS = [
  { label: "Product", href: "#product" },
  { label: "Templates", href: "#templates" },
  { label: "China", href: "#china" },
  { label: "Pricing", to: "/pricing" },
  { label: "Docs", to: "/features" },
];

interface LandingNavProps {
  onLoginClick: () => void;
  onLaunch: () => void;
}

export function LandingNav({ onLoginClick, onLaunch }: LandingNavProps) {
  return (
    <nav className="nav">
      <div className="nav__inner">
        <Link to="/" className="nav__brand">
          <img src={logoSrc} alt="ecomgear" className="nav__logo" />
        </Link>
        <div className="nav__links">
          {NAV_LINKS.map((link) => (
            link.to ? (
              <Link key={link.label} to={link.to} className="nav__link">{link.label}</Link>
            ) : (
              <a key={link.label} href={link.href} className="nav__link">{link.label}</a>
            )
          ))}
        </div>
        <div className="nav__actions">
          <button className="nav__sign-in" onClick={onLoginClick} type="button">Sign in</button>
          <button className="btn btn--sm btn--primary" onClick={onLaunch} type="button">Launch →</button>
        </div>
      </div>
    </nav>
  );
}
