import { useState } from "react";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate, useLocation, Link } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import logoSrc from "@/assets/ecomgear-auth-logo.png";

const NAV_LINKS = [
  { href: "/product", label: "Product" },
  { href: "/china", label: "China" },
  { href: "/pricing", label: "Pricing" },
  { href: "/agents", label: "Agents" },
  { href: "/contact", label: "Contact" },
  { href: "https://ecomgear.ai", label: "eCG.ai", external: true },
];

interface HeaderProps {
  onLoginClick: () => void;
  user: User | null;
}

export const Header = ({ onLoginClick, user }: HeaderProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  const isActive = (path: string) => location.pathname === path;

  return (
    <header className="nav">
      <div className="nav__inner">
        <Link to="/" className="nav__brand shrink-0" aria-label="ecomgear home">
          <img src={logoSrc} alt="ecomgear" className="nav__logo" />
        </Link>

        <nav className="nav__links hidden md:flex">
          {NAV_LINKS.map(({ href, label, external }) => (
            external ? (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="nav__link"
              >
                {label}
              </a>
            ) : (
              <Link
                key={href}
                to={href}
                className={`nav__link ${
                  isActive(href) ? "is-active" : ""
                }`}
              >
                {label}
              </Link>
            )
          ))}
        </nav>

        <div className="nav__actions hidden md:flex">
          {user ? (
            <Button
              onClick={() => navigate("/dashboard")}
              size="sm"
              className="btn btn--sm btn--primary"
            >
              Dashboard
            </Button>
          ) : (
            <>
              <button onClick={() => navigate('/auth?tab=login')} className="nav__sign-in" type="button">
                Log in
              </button>
              <Button
                onClick={onLoginClick}
                size="sm"
                className="btn btn--sm btn--primary"
              >
                Launch →
              </Button>
            </>
          )}
        </div>

        <button
          className="nav__sign-in md:hidden"
          onClick={() => setIsMobileOpen((v) => !v)}
          aria-label="Toggle menu"
          type="button"
        >
          {isMobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {isMobileOpen && (
        <div className="nav__mobile md:hidden">
          {NAV_LINKS.map(({ href, label, external }) => (
            external ? (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="nav__mobile-link"
                onClick={() => setIsMobileOpen(false)}
              >
                {label}
              </a>
            ) : (
              <Link
                key={href}
                to={href}
                className="nav__mobile-link"
                onClick={() => setIsMobileOpen(false)}
              >
                {label}
              </Link>
            )
          ))}
          <div className="mt-3 grid grid-cols-2 gap-2">
            {user ? (
              <Button
                onClick={() => {
                  setIsMobileOpen(false);
                  navigate("/dashboard");
                }}
                className="col-span-2 btn btn--primary"
              >
                Dashboard
              </Button>
            ) : (
              <>
                <Button
                  onClick={() => {
                    setIsMobileOpen(false);
                    navigate('/auth?tab=login');
                  }}
                  variant="ghost"
                  className="btn btn--ghost"
                >
                  Log in
                </Button>
                <Button onClick={onLoginClick} className="btn btn--primary">
                  Launch →
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
};
