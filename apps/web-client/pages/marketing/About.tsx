import "../../styles/about.css";

const principles = [
  { number: "01", title: "Systems over tools", copy: "Most businesses collect software. We build connected systems that actually run the work. One agent, one conversation, one operating view." },
  { number: "02", title: "Approval before action", copy: "Automation without oversight is just faster mistakes. Every plan goes through an explicit review step before anything executes." },
  { number: "03", title: "Built for operators", copy: "No technical setup. No configuration files. No assembly required. Describe the outcome and the agent handles the rest." },
];

export default function About() {
  return (
    <>
      <section className="smes-about-hero">
        <div className="smes-site-page-hero__inner smes-site-reveal">
          <h1>Business automation, rethought.</h1>
          <p className="smes-site-page-hero__copy">
            We built SMEs Agent because growing businesses deserve better than duct-taped tool stacks and manual handoffs.
          </p>
        </div>
      </section>

      <section className="smes-about-mission smes-site-reveal">
        <div className="smes-site-section__inner">
          <div className="smes-about-mission__grid">
            <div>
              <h2>Our mission</h2>
            </div>
            <div>
              <p>Small and medium businesses run the economy, but they&apos;re stuck with enterprise complexity at a fraction of the resources. SMEs Agent changes that.</p>
              <p>We believe business automation should feel like working with a sharp colleague, not configuring software. One prompt starts the conversation. One system runs the work. One place tracks everything.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="smes-about-stats smes-site-reveal">
        <div className="smes-about-stats__inner">
          <div className="smes-about-stat">
            <span className="smes-about-stat__value">2025</span>
            <span className="smes-about-stat__label">Founded</span>
          </div>
          <div className="smes-about-stat">
            <span className="smes-about-stat__value">100%</span>
            <span className="smes-about-stat__label">Remote team</span>
          </div>
          <div className="smes-about-stat">
            <span className="smes-about-stat__value">SOC 2</span>
            <span className="smes-about-stat__label">Certified</span>
          </div>
          <div className="smes-about-stat">
            <span className="smes-about-stat__value">GDPR</span>
            <span className="smes-about-stat__label">Compliant</span>
          </div>
        </div>
      </section>

      <section className="smes-about-approach smes-site-reveal">
        <div className="smes-site-section__inner">
          <h2>How we think about the work.</h2>
          <div className="smes-about-principles">
            {principles.map(({ number, title, copy }) => (
              <div className="smes-about-principle" key={number}>
                <span className="smes-about-principle__number">{number}</span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="smes-about-team smes-site-reveal">
        <div className="smes-site-section__inner">
          <div className="smes-about-team__grid">
            <div>
              <h2>Built by people who&apos;ve run the work.</h2>
              <p>Our team comes from operations, strategy, and engineering backgrounds across small businesses and enterprises. We&apos;ve lived the problem of disconnected tools and manual processes.</p>
            </div>
            <div className="smes-about-team__roles">
              <div className="smes-about-team__role">
                <span className="smes-about-team__role-label">Engineering</span>
                <span className="smes-about-team__role-detail">Agent architecture, infrastructure, security</span>
              </div>
              <div className="smes-about-team__role">
                <span className="smes-about-team__role-label">Product</span>
                <span className="smes-about-team__role-detail">Workflow design, operator experience</span>
              </div>
              <div className="smes-about-team__role">
                <span className="smes-about-team__role-label">Strategy</span>
                <span className="smes-about-team__role-detail">Business systems, go-to-market</span>
              </div>
              <div className="smes-about-team__role">
                <span className="smes-about-team__role-label">Operations</span>
                <span className="smes-about-team__role-detail">Logistics, process automation</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
