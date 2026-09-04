import { Link } from "react-router-dom";
import { ArrowUp, ArrowUpRight } from "lucide-react";
import BrandLoader from "@/components/BrandLoader";
import { useLandingContext } from "@/contexts/LandingContext";
import "../../styles/home.css";

export default function Home() {
  const { onLaunch } = useLandingContext();

  return (
    <>
      <section className="smes-home-hero">
        <div className="smes-home-hero__inner smes-site-reveal">
          <h1>Build business systems with one prompt.</h1>
          <p className="smes-home-hero__copy">
            SMEs Agent turns your business goals into working systems: strategy, content, sales, operations. Coordinated from a single conversation. SOC 2 certified. GDPR compliant.
          </p>
          <div className="smes-home-hero__actions">
            <button className="smes-site-button smes-site-button--dark" type="button" onClick={onLaunch}>
              Start building <ArrowUpRight aria-hidden="true" size={16} />
            </button>
            <Link to="/features" className="smes-site-button smes-site-button--light">
              See how it works
            </Link>
          </div>
          <div className="smes-home-hero__visual">
            <BrandLoader variant="compass" size={160} label="SMEs Agent" />
          </div>
        </div>
      </section>

      <section className="smes-home-proof smes-site-reveal">
        <div className="smes-home-proof__inner">
          <p>Trusted by operators at growing businesses worldwide</p>
        </div>
      </section>

      <section className="smes-home-system smes-site-reveal">
        <div className="smes-home-system__inner">
          <h2>One agent. Every business function.</h2>
          <div className="smes-home-system__diagram">
            <div className="smes-home-system__node smes-home-system__node--center">
              <span>SMEs Agent</span>
            </div>
            <div className="smes-home-system__node smes-home-system__node--top">
              <span>Strategy</span>
            </div>
            <div className="smes-home-system__node smes-home-system__node--right">
              <span>Content</span>
            </div>
            <div className="smes-home-system__node smes-home-system__node--bottom">
              <span>Sales</span>
            </div>
            <div className="smes-home-system__node smes-home-system__node--left">
              <span>Operations</span>
            </div>
            <svg className="smes-home-system__lines" viewBox="0 0 400 400" fill="none">
              <line x1="200" y1="200" x2="200" y2="60" stroke="rgba(255,255,255,0.2)" stroke-dasharray="4 4" />
              <line x1="200" y1="200" x2="340" y2="200" stroke="rgba(255,255,255,0.2)" stroke-dasharray="4 4" />
              <line x1="200" y1="200" x2="200" y2="340" stroke="rgba(255,255,255,0.2)" stroke-dasharray="4 4" />
              <line x1="200" y1="200" x2="60" y2="200" stroke="rgba(255,255,255,0.2)" stroke-dasharray="4 4" />
            </svg>
          </div>
        </div>
      </section>

      <section className="smes-home-metrics smes-site-reveal">
        <div className="smes-home-metrics__inner">
          <div className="smes-home-metric">
            <span className="smes-home-metric__value">1</span>
            <span className="smes-home-metric__label">Agent</span>
          </div>
          <div className="smes-home-metric">
            <span className="smes-home-metric__value">4</span>
            <span className="smes-home-metric__label">Business functions</span>
          </div>
          <div className="smes-home-metric">
            <span className="smes-home-metric__value">1</span>
            <span className="smes-home-metric__label">Conversation</span>
          </div>
          <div className="smes-home-metric">
            <span className="smes-home-metric__value">0</span>
            <span className="smes-home-metric__label">Tools to manage</span>
          </div>
        </div>
      </section>

      <section className="smes-home-operating smes-site-reveal">
        <div className="smes-home-operating__inner">
          <div>
            <h2>Stop switching between tools. Start building systems.</h2>
          </div>
          <p>
            Work shouldn&apos;t disappear into disconnected tabs and handoffs. SMEs Agent keeps the prompt, the plan, and the execution in one operating view so you can move from idea to working system without leaving the conversation.
          </p>
        </div>
      </section>

      <section className="smes-home-links smes-site-reveal">
        <div className="smes-home-links__inner">
          <Link to="/features" className="smes-home-link-card">
            <h3>See what it can do</h3>
            <p>Workflow automation, content systems, sales pipelines, and operations, all from one agent.</p>
          </Link>
          <Link to="/pricing" className="smes-home-link-card">
            <h3>Simple pricing</h3>
            <p>Start free. Scale as you grow. No hidden fees, no long-term contracts.</p>
          </Link>
        </div>
      </section>

      <section className="smes-home-final">
        <div className="smes-home-final__inner smes-site-reveal">
          <h2>Start with the work that matters most.</h2>
          <p>Give SMEs Agent the outcome. Build the system from there.</p>
          <div className="smes-home-final__composer" onClick={onLaunch}>
            <span>What do you need to run better?</span>
            <button type="button" aria-label="Start building">
              <ArrowUp aria-hidden="true" size={16} />
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
