import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import brandIcon from "@/assets/logo/svg/smes-agent-icon.svg";
import "../../styles/root-landing.css";

interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

interface LegalPageProps {
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
}

export function LegalPage({ title, updated, intro, sections }: LegalPageProps) {
  return (
    <div className="smes-root-legal">
      <header className="smes-root-legal__nav">
        <Link to="/" className="smes-root-brand" aria-label="SMEs Agent home">
          <img src={brandIcon} alt="" aria-hidden="true" />
          <span>SMEs Agent</span>
        </Link>
        <Link to="/" className="smes-root-legal__back">
          <ArrowLeft aria-hidden="true" size={16} />
          Back to home
        </Link>
      </header>
      <main className="smes-root-legal__main">
        <p className="smes-root-kicker">Legal</p>
        <h1>{title}</h1>
        <p className="smes-root-legal__updated">Last updated {updated}</p>
        <p className="smes-root-legal__intro">{intro}</p>
        {sections.map(({ heading, paragraphs, bullets }) => (
          <section key={heading}>
            <h2>{heading}</h2>
            {paragraphs?.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            {bullets ? (
              <ul>
                {bullets.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </main>
      <footer className="smes-root-legal__footer">
        <span>© {new Date().getFullYear()} SMEs Agent. All rights reserved.</span>
        <span>
          <Link to="/privacy">Privacy policy</Link>
          {" · "}
          <Link to="/terms">Terms of service</Link>
        </span>
      </footer>
    </div>
  );
}
