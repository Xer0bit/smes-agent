import { Lock, Shield, Key, Server, Eye, AlertTriangle } from "lucide-react";

const SECURITY_FEATURES = [
    {
        icon: Lock,
        color: "text-blue-400",
        bg: "bg-blue-500/10 border-blue-500/20",
        title: "End-to-End Encryption",
        description: "All data transmitted between your browser and our servers is encrypted using TLS 1.3."
    },
    {
        icon: Key,
        color: "text-indigo-400",
        bg: "bg-indigo-500/10 border-indigo-500/20",
        title: "Secure Authentication",
        description: "Multi-factor authentication with Supabase Auth. Passwords are never stored in plaintext."
    },
    {
        icon: Server,
        color: "text-cyan-400",
        bg: "bg-cyan-500/10 border-cyan-500/20",
        title: "Infrastructure Security",
        description: "Hosted on enterprise-grade infrastructure with 24/7 monitoring and DDoS protection."
    },
    {
        icon: Eye,
        color: "text-emerald-400",
        bg: "bg-emerald-500/10 border-emerald-500/20",
        title: "Regular Audits",
        description: "Third-party security audits and penetration testing performed quarterly."
    },
    {
        icon: Shield,
        color: "text-amber-400",
        bg: "bg-amber-500/10 border-amber-400/20",
        title: "Data Isolation",
        description: "Row-level security ensures your projects and data are completely isolated from other users."
    },
    {
        icon: AlertTriangle,
        color: "text-rose-400",
        bg: "bg-rose-500/10 border-rose-500/20",
        title: "Incident Response",
        description: "24/7 security monitoring with rapid incident response protocols."
    }
];

const COMPLIANCE = [
    { title: "GDPR Compliant", description: "Fully compliant with EU General Data Protection Regulation requirements." },
    { title: "SOC 2 Aligned", description: "Security, availability, and confidentiality controls aligned with SOC 2 standards." },
    { title: "ISO 27001 Aligned", description: "Information security management practices following ISO 27001 framework." },
    { title: "CCPA Compliant", description: "Adheres to California Consumer Privacy Act standards." },
];

export default function Security() {
    return (
        <div className="min-h-screen bg-[#101622] text-white">

            {/* Hero */}
            <section className="relative pt-28 pb-16 px-6 overflow-hidden">
                <div className="absolute inset-0 -z-10 pointer-events-none">
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[60%] h-[50%] rounded-full bg-blue-500/8 blur-[140px]" />
                </div>
                <div className="max-w-3xl mx-auto text-center">
                    <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 mb-6">
                        <Shield className="w-7 h-7 text-blue-400" />
                    </div>
                    <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-5">
                        Security at{" "}
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-400">
                            eCOMGear
                        </span>
                    </h1>
                    <p className="text-lg text-slate-400 max-w-2xl mx-auto">
                        Your security is our top priority. We implement industry-leading measures to protect your data and projects.
                    </p>
                </div>
            </section>

            {/* Security Features Grid */}
            <section className="pb-20 px-6">
                <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {SECURITY_FEATURES.map(({ icon: Icon, color, bg, title, description }) => (
                        <div
                            key={title}
                            className="group p-6 rounded-2xl bg-[#182234] border border-white/5 hover:border-white/10 transition-all duration-300"
                        >
                            <div className={`w-10 h-10 rounded-lg border flex items-center justify-center mb-4 ${bg}`}>
                                <Icon className={`w-5 h-5 ${color}`} />
                            </div>
                            <h3 className="text-base font-semibold text-white mb-2">{title}</h3>
                            <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
                        </div>
                    ))}
                </div>
            </section>

            {/* Compliance */}
            <section className="px-6 pb-20">
                <div className="max-w-5xl mx-auto rounded-2xl bg-[#182234] border border-white/5 p-8">
                    <h2 className="text-2xl font-bold text-white mb-6">Compliance &amp; Certifications</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {COMPLIANCE.map(({ title, description }) => (
                            <div key={title}>
                                <h3 className="text-base font-semibold text-white mb-1">{title}</h3>
                                <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* Responsible Disclosure */}
            <section className="px-6 pb-24">
                <div className="max-w-5xl mx-auto rounded-2xl bg-[#182234] border border-white/5 p-8">
                    <h2 className="text-2xl font-bold text-white mb-4">Responsible Disclosure</h2>
                    <p className="text-slate-400 text-sm leading-relaxed mb-4">
                        If you discover a security vulnerability, please report it to us responsibly. We appreciate the security research community's efforts in keeping eCOMGear secure.
                    </p>
                    <p className="text-slate-400 text-sm">
                        Report security issues to:{" "}
                        <a href="mailto:info@ecomgear.dev" className="text-blue-400 hover:text-blue-300 transition-colors">
                            info@ecomgear.dev
                        </a>
                    </p>
                </div>
            </section>
        </div>
    );
}
