import { Link } from "react-router-dom";
import brandIcon from "@/assets/logo/svg/smes-agent-icon.svg";
import { useLandingContext } from "@/contexts/LandingContext";

export default function SiteFooter() {
  const { user, onLoginClick, onLaunch } = useLandingContext();

  return (
    <footer className="smes-site-footer">
      <div className="smes-site-footer__inner">
        <div className="smes-site-footer__top">
          <Link to="/" className="smes-site-brand" aria-label="SMEs Agent home">
            <img src={brandIcon} alt="" aria-hidden="true" style={{ width: "1.25rem", height: "1.25rem", display: "block" }} />
            <span>SMEs Agent</span>
          </Link>
          <p>Enterprise automation for growing businesses.</p>
        </div>

        <div className="smes-site-footer__links">
          <div>
            <span>Product</span>
            <Link to="/features">Features</Link>
            <Link to="/pricing">Pricing</Link>
            <Link to="/contact">Contact</Link>
          </div>
          <div>
            <span>Company</span>
            <Link to="/about">About</Link>
            <a href="mailto:support@xer0bit.com">Contact</a>
          </div>
          <div>
            <span>Account</span>
            {user ? (
              <button type="button" onClick={onLaunch}>Dashboard</button>
            ) : (
              <>
                <button type="button" onClick={onLoginClick}>Log in</button>
                <button type="button" onClick={onLaunch}>Sign up</button>
              </>
            )}
            <button type="button" onClick={onLaunch}>Start building</button>
          </div>
          <div>
            <span>Legal</span>
            <Link to="/privacy">Privacy policy</Link>
            <Link to="/terms">Terms of service</Link>
          </div>
        </div>

        <div className="smes-site-footer__bottom">
          <span>&copy; {new Date().getFullYear()} SMEs Agent. All rights reserved.</span>
          <span>SOC 2 Type II &middot; GDPR Compliant &middot; ISO 27001</span>
        </div>
      </div>
    </footer>
  );
}
