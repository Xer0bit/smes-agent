import { FC } from 'react';
import { CheckCircle2, Layers3, Workflow } from 'lucide-react';
import { motion } from 'framer-motion';

export const LovableFeatures: FC = () => {
    return (
        <section className="mx-auto w-full max-w-7xl bg-[#0b1220] px-6 py-16 text-white lg:px-10">
            <div className="mb-8 max-w-2xl">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-300">Workflow</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                    Minimal steps. Real outcomes.
                </h2>
            </div>

            <div className="grid gap-5 md:grid-cols-3">
                <motion.article
                    initial={{ opacity: 0, y: 14 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.35 }}
                    transition={{ duration: 0.45, ease: 'easeOut' }}
                    className="rounded-2xl border border-white/10 bg-[#10192d] p-6 transition-colors hover:border-cyan-300/30"
                >
                    <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-400/15">
                        <Workflow className="h-5 w-5 text-cyan-300" />
                    </div>
                    <h3 className="text-lg font-semibold">Brief with intent</h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-300">
                        Define business goals and UX direction before generation starts.
                    </p>
                </motion.article>

                <motion.article
                    initial={{ opacity: 0, y: 14 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.35 }}
                    transition={{ duration: 0.45, delay: 0.08, ease: 'easeOut' }}
                    className="rounded-2xl border border-white/10 bg-[#10192d] p-6 transition-colors hover:border-cyan-300/30"
                >
                    <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-400/15">
                        <Layers3 className="h-5 w-5 text-cyan-300" />
                    </div>
                    <h3 className="text-lg font-semibold">Generate with visibility</h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-300">
                        Review generated output, revisions, and previews in one place.
                    </p>
                </motion.article>

                <motion.article
                    initial={{ opacity: 0, y: 14 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.35 }}
                    transition={{ duration: 0.45, delay: 0.16, ease: 'easeOut' }}
                    className="rounded-2xl border border-white/10 bg-[#10192d] p-6 transition-colors hover:border-cyan-300/30"
                >
                    <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-400/15">
                        <CheckCircle2 className="h-5 w-5 text-cyan-300" />
                    </div>
                    <h3 className="text-lg font-semibold">Ship confidently</h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-300">
                        Publish with clear ownership, checks, and auditable decisions.
                    </p>
                </motion.article>
            </div>
        </section>
    );
};
