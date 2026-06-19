import { useState } from "react";

const FAQS = [
  { q: "How does Ecomgear publish to China?", a: "We handle Chinese CDN hosting, ICP filing, WeChat Pay & Alipay integration, and WeChat Mini Program publishing. The agent guides you through the paperwork and automates everything else. Most SMEs go live on .cn within 10–15 business days, most of which is government filing time." },
  { q: "Do I need technical skills?", a: "No. You describe your business in plain language (English or 中文). The agent designs, builds, localizes, and publishes. You review and approve. If you're comfortable writing an email, you can launch a cross-border storefront." },
  { q: "Can I import an existing Shopify / Wix / WordPress store?", a: "Yes. Point the agent at your existing site, and it will mirror your catalog, brand, and content into a new Ecomgear instance — then localize for China. You can keep your old store running in parallel." },
  { q: "Who owns the site and data?", a: "You do. Full export to static HTML, CSV catalog, and standard database formats. No lock-in. Custom domains stay on your registrar." },
  { q: "How does pricing compare to hiring an agency?", a: "A traditional localized China launch runs $30–80k and takes 3–6 months. Ecomgear's Business plan is $89/month and goes live in days. We're the first option that's priced like SaaS and works like an agency." },
  { q: "Is the agent safe to leave running?", a: "Yes. Every agent action is logged, reversible, and gated by permissions you set. High-impact actions (price changes >10%, catalog deletions, domain changes) always require your approval by default." },
];

export function FaqSection() {
  const [open, setOpen] = useState(0);

  return (
    <section className="faq" id="faq">
      <div className="section-head">
        <div className="section-head__num">06</div>
        <div className="section-head__label">FAQ</div>
        <div className="section-head__spacer" />
      </div>
      <div className="faq__inner">
        <h2 className="section-title faq__title">
          Questions,<br />
          <span className="section-title__accent">answered.</span>
        </h2>
        <div className="faq__list">
          {FAQS.map((item, i) => {
            const isOpen = open === i;
            return (
              <div key={i} className={`faq-item ${isOpen ? "is-open" : ""}`}>
                <button
                  className="faq-item__q"
                  onClick={() => setOpen(isOpen ? -1 : i)}
                >
                  <span>{item.q}</span>
                  <span className="faq-item__icon">{isOpen ? "–" : "+"}</span>
                </button>
                <div className="faq-item__a">
                  <div className="faq-item__a-inner">{item.a}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
