import { FC } from 'react';

export const Stats: FC = () => {
    return (
        <section className="mx-auto w-full max-w-7xl bg-[#0b1220] px-6 py-20 text-white lg:px-10">
            <div className="mb-8 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-300">Operational outcomes</p>
                    <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Results teams can report upstream</h2>
                </div>
                <p className="max-w-xl text-sm leading-relaxed text-slate-300">
                    eCOMGear is designed for measurable delivery gains across product launches, revision cycles, and production readiness.
                </p>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
                <article className="rounded-2xl border border-white/10 bg-[#10192d] p-7">
                    <p className="text-4xl font-semibold text-white sm:text-5xl">3.2x</p>
                    <p className="mt-2 text-sm font-medium text-slate-200">faster concept-to-preview cycle</p>
                    <p className="mt-4 text-xs text-slate-400">Median across teams shipping weekly storefront updates.</p>
                </article>

                <article className="rounded-2xl border border-white/10 bg-[#10192d] p-7">
                    <p className="text-4xl font-semibold text-white sm:text-5xl">42%</p>
                    <p className="mt-2 text-sm font-medium text-slate-200">fewer rework rounds per feature</p>
                    <p className="mt-4 text-xs text-slate-400">Driven by revision history, shared context, and preview-first review.</p>
                </article>

                <article className="rounded-2xl border border-white/10 bg-[#10192d] p-7">
                    <p className="text-4xl font-semibold text-white sm:text-5xl">99.9%</p>
                    <p className="mt-2 text-sm font-medium text-slate-200">workspace uptime target</p>
                    <p className="mt-4 text-xs text-slate-400">Infrastructure and deployment flow aligned for production teams.</p>
                </article>
            </div>
        </section>
    );
};
