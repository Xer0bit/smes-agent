import { FC } from 'react';

const caseStudies = [
  {
    title: 'Cross-border electronics storefront',
    subtitle: 'Reduced design-to-release cycle from 4 weeks to 9 days',
    metric: '+31% checkout completion',
  },
  {
    title: 'Beauty brand campaign landing system',
    subtitle: 'Reusable page templates for CN, HK, and US market teams',
    metric: '48 launches / quarter',
  },
  {
    title: 'DTC apparel product page overhaul',
    subtitle: 'Preview-led iteration across product, growth, and engineering',
    metric: '+19% product page conversion',
  },
];

const integrations = ['Shopify', 'BigCommerce', 'Stripe', 'Supabase', 'Cloudflare', 'Vercel'];

export const DiscoverGrids: FC = () => {
    return (
        <section className="mx-auto w-full max-w-7xl bg-[#0b1220] px-6 py-20 text-white lg:px-10">
            <div className="mb-8">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-300">Proof of impact</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Built for teams with delivery pressure</h2>
            </div>

            <div className="grid gap-5 md:grid-cols-3">
                {caseStudies.map((item) => (
                  <article key={item.title} className="rounded-2xl border border-white/10 bg-[#10192d] p-6">
                    <h3 className="text-lg font-semibold text-white">{item.title}</h3>
                    <p className="mt-3 text-sm leading-relaxed text-slate-300">{item.subtitle}</p>
                    <p className="mt-5 inline-flex rounded-full border border-cyan-300/30 bg-cyan-400/10 px-3 py-1 text-xs font-semibold text-cyan-200">
                      {item.metric}
                    </p>
                  </article>
                ))}
            </div>

            <div className="mt-14 rounded-2xl border border-white/10 bg-[#0e172b] p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">Works with your stack</p>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    {integrations.map((item) => (
                      <div key={item} className="rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-center text-sm text-slate-200">
                        {item}
                      </div>
                    ))}
                </div>
            </div>
        </section>
    );
};
