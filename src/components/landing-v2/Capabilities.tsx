const CAPS = [
  { k: "01", t: "Designs your site", body: "Generates a bilingual, on-brand storefront from a prompt, Notion workspace, or spreadsheet. Every layout is editable.", stat: "~4 min", statLabel: "first publish" },
  { k: "02", t: "Localizes everything", body: "Copy, currency, units, payment rails, even return policies — adapted per market. English, 中文, and 40+ more.", stat: "47", statLabel: "locales" },
  { k: "03", t: "Publishes to China", body: "yourbrand.cn on Chinese CDN, ICP filing, WeChat Pay, Alipay, WeChat Mini Program — done by the agent, not you.", stat: "94ms", statLabel: "Beijing TTFB" },
  { k: "04", t: "Runs the backend", body: "Orders, inventory, customer support across timezones. The agent is on call while you sleep.", stat: "24/7", statLabel: "on duty" },
  { k: "05", t: "Measures & iterates", body: "Watches conversion, A/B-tests headlines, surfaces the bottleneck and ships the fix for your review.", stat: "+31%", statLabel: "avg conv. lift" },
  { k: "06", t: "Talks to your stack", body: "Shopify, Notion, Figma, Stripe, 抖音小店, 微信, 小红书. If it has an API, the agent has read the docs.", stat: "120+", statLabel: "integrations" },
];

export function Capabilities() {
  return (
    <section className="caps">
      <div className="section-head">
        <div className="section-head__num">04</div>
        <div className="section-head__label">CAPABILITIES</div>
        <div className="section-head__spacer" />
      </div>
      <div className="caps__head">
        <h2 className="section-title">
          Not a toolkit.<br />
          <span className="section-title__accent">An operator.</span>
        </h2>
        <p className="section-sub">
          Ecomgear isn't a stack of features you wire up yourself. It's one
          autonomous agent that does the work of a designer, developer,
          translator, and ops manager — on your behalf, 24/7.
        </p>
      </div>
      <div className="caps__grid">
        {CAPS.map((c) => (
          <div key={c.k} className="cap">
            <div className="cap__top">
              <span className="cap__k">{c.k}</span>
              <span className="cap__stat">
                <span className="cap__stat-num">{c.stat}</span>
                <span className="cap__stat-label">{c.statLabel}</span>
              </span>
            </div>
            <div className="cap__t">{c.t}</div>
            <div className="cap__body">{c.body}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
