import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowUpRight, Menu, X } from "lucide-react";
import BrandLoader from "@/components/BrandLoader";
import { useLandingContext } from "@/contexts/LandingContext";

export default function SiteHeader() {
  const { user, onLoginClick, onLaunch } = useLandingContext();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const closeMenu = () => setMenuOpen(false);
  const isActive = (path: string) => location.pathname === path;

  return (
    <header className="smes-site-nav">
      <div className="smes-site-nav__inner">
        <Link to="/" className="smes-site-brand" aria-label="SMEs Agent home" onClick={closeMenu}>
          <BrandLoader variant="bead" size={28} label="SMEs Agent" />
          <span>SMEs Agent</span>
        </Link>

        <nav className="smes-site-nav__links" aria-label="Primary navigation">
          <Link to="/features" className={isActive("/features") ? "active" : ""}>Product</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/about">About</Link>
          <Link to="/contact">Contact</Link>
        </nav>

        <div className="smes-site-nav__actions">
          {user ? (
            <button className="smes-site-nav__text" type="button" onClick={onLaunch}>
              Dashboard
            </button>
          ) : (
            <button className="smes-site-nav__text" type="button" onClick={onLoginClick}>
              Log in
            </button>
          )}
          <button className="smes-site-button smes-site-button--dark" type="button" onClick={onLaunch}>
            Start building <ArrowUpRight aria-hidden="true" size={16} />
          </button>
        </div>

        <button
          className="smes-site-nav__menu"
          type="button"
          aria-label="Toggle navigation"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X aria-hidden="true" size={20} /> : <Menu aria-hidden="true" size={20} />}
        </button>
      </div>

      {menuOpen && (
        <nav className="smes-site-nav__mobile" aria-label="Mobile navigation">
          <Link to="/features" onClick={closeMenu}>Product</Link>
          <Link to="/pricing" onClick={closeMenu}>Pricing</Link>
          <Link to="/about" onClick={closeMenu}>About</Link>
          <Link to="/contact" onClick={closeMenu}>Contact</Link>
          {user ? (
            <button type="button" onClick={() => { closeMenu(); onLaunch(); }}>Dashboard</button>
          ) : (
            <button type="button" onClick={() => { closeMenu(); onLoginClick(); }}>Log in</button>
          )}
          <button className="smes-site-button smes-site-button--dark" type="button" onClick={() => { closeMenu(); onLaunch(); }}>
            Start building <ArrowUpRight aria-hidden="true" size={16} />
          </button>
        </nav>
      )}
    </header>
  );
}
