import { Target, Users, Globe, Zap, Code2, Mail, Network, ServerCog } from "lucide-react";
import { Link } from "react-router-dom";

const PRODUCTS = [
  {
    icon: Code2,
    color: "text-cyan-400",
    bg: "bg-cyan-500/10 border-cyan-500/20",
    tag: "Build",
    name: "eCGDev",
    description:
      "AI-powered development platform enabling SMEs to build and deploy web applications with one click, including China-ready ICP-compliant deployment.",
    bullets: [
      "AI code generation",
      "One-click deploy: Global + CN (ICP)",
      "Role-based workspace access",
      "AI Agents built-in for everyday tasks",
    ],
  },
  {
    icon: Mail,
    color: "text-indigo-400",
    bg: "bg-indigo-500/10 border-indigo-500/20",
    tag: "Automate",
    name: "OneMail",
    description:
      "AI agent system that automates internal workflows, communication, and operational tasks across organizations.",
    bullets: [
      "Dedicated AI agent per mailbox",
      "Gmail, Outlook, Exchange, IMAP",
      "Effectively manage communications in the SME business context",
    ],
  },
  {
    icon: Network,
    color: "text-emerald-400",
    bg: "bg-emerald-500/10 border-emerald-500/20",
    tag: "Connect",
    name: "OneNET",
    description:
      "Private network infrastructure enabling secure cross-border access, connecting SMEs to global and China/ASEAN servers with GPU and high-performance computing resources.",
    bullets: [
      "Global VPN: HK, CN, SG, US, EU",
      "GPU & high-performance computing",
      "Secure cross-border access",
    ],
  },
  {
    icon: ServerCog,
    color: "text-purple-400",
    bg: "bg-purple-500/10 border-purple-500/20",
    tag: "Operate",
    name: "Network Live",
    description:
      "Distributed compute exchange pooling idle CPU and GPU resources into AI inference, VPN credits, and high-performance workloads.",
    bullets: [
      "Network Compute Pool   4,221 TH/s",
      "1,847 active AI agents",
      "VPN Credits earned from contributing compute",
    ],
  },
];

const PILLARS = [
  {
    icon: Zap,
    color: "text-cyan-400",
    bg: "bg-cyan-500/10 border-cyan-500/20",
    title: "Build",
    description:
      "One prompt to a production-ready application. eCGDev generates clean TypeScript, handles China ICP compliance, and deploys globally.",
  },
  {
    icon: Target,
    color: "text-indigo-400",
    bg: "bg-indigo-500/10 border-indigo-500/20",
    title: "Connect",
    description:
      "OneNET gives SMEs private, secure cross-border connectivity   WireGuard VPN across HK, CN, SG, US, and EU edge nodes with GPU compute on demand.",
  },
  {
    icon: Globe,
    color: "text-emerald-400",
    bg: "bg-emerald-500/10 border-emerald-500/20",
    title: "Operate",
    description:
      "OneMail's dedicated AI agents automate communications across every major email and collaboration platform, freeing teams to focus on growth.",
  },
  {
    icon: Users,
    color: "text-purple-400",
    bg: "bg-purple-500/10 border-purple-500/20",
    title: "Scale",
    description:
      "Unified billing, workspace roles, and per-seat plans designed for SMEs expanding from local to global and China/ASEAN markets.",
  },
];

const TECH = [
  { label: "VPN Protocol",  value: "WireGuard" },
  { label: "AI Model",      value: "Claude / Gemini" },
  { label: "Vector DB",     value: "Pinecone" },
  { label: "VM Stack",      value: "KVM / QEMU" },
  { label: "CN Deploy",     value: "ICP Licensed" },
  { label: "Edge Nodes",    value: "HK · CN · SG · US · EU" },
];

const METRICS = [
  { stat: "3", label: "Core products" },
  { stat: "5", label: "Edge regions" },
  { stat: "4,221 TH/s", label: "Network compute" },
  { stat: "99.9%", label: "Platform uptime" },
];

export default function About() {
  return (
    <div className="min-h-screen bg-[#101622] text-white">

      {/* Hero */}
      <section className="relative pt-28 pb-16 px-6 overflow-hidden">
        <div className="max-w-3xl mx-auto text-center">

          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
            Accelerate SME{" "}
            <span className="text-primary">
              Digital to AI
            </span>{" "}
            Transformation
          </h1>
          <p className="text-lg md:text-xl text-slate-400 leading-relaxed max-w-2xl mx-auto">
            Build, connect, and operate on a single AI-powered platform.
            Application development, cross-border infrastructure, and intelligent automation  
            unified for SMEs expanding across global, China, and ASEAN markets.
          </p>
        </div>
      </section>

      {/* Stats */}
      <section className="border-y border-white/5 bg-[#0d1424] py-10 px-6">
        <div className="max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
          {METRICS.map(({ stat, label }) => (
            <div key={label}>
              <p className="text-3xl font-bold text-white mb-1">{stat}</p>
              <p className="text-sm text-slate-500">{label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Products */}
      <section className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-2xl md:text-4xl font-bold text-white mb-3">Integrated Solutions</h2>
            <p className="text-slate-400 max-w-xl mx-auto">Build. Connect. Operate.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {PRODUCTS.map(({ icon: Icon, color, bg, tag, name, description, bullets }) => (
              <div
                key={name}
                className="p-6 rounded-2xl bg-[#182234] border border-white/5 hover:border-white/10 transition-all duration-300"
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className={`w-10 h-10 rounded-lg border flex items-center justify-center shrink-0 ${bg}`}>
                    <Icon className={`w-5 h-5 ${color}`} />
                  </div>
                  <div>
                    <span className={`text-[10px] font-semibold uppercase tracking-widest ${color}`}>{tag}</span>
                    <h3 className="text-base font-bold text-white leading-tight">{name}</h3>
                  </div>
                </div>
                <p className="text-sm text-slate-400 leading-relaxed mb-4">{description}</p>
                <ul className="space-y-1.5">
                  {bullets.map(b => (
                    <li key={b} className="flex items-start gap-2 text-xs text-slate-400">
                      <span className="mt-0.5 text-cyan-400">✓</span>
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Principles */}
      <section className="py-16 px-6 bg-[#0d1424]">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-2xl md:text-4xl font-bold text-white mb-3">Our principles</h2>
            <p className="text-slate-400 max-w-lg mx-auto">
              Every product decision is guided by these four commitments.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {PILLARS.map(({ icon: Icon, color, bg, title, description }) => (
              <div
                key={title}
                className="p-6 rounded-2xl bg-[#182234] border border-white/5 hover:border-white/10 transition-all duration-300"
              >
                <div className={`w-10 h-10 rounded-lg border flex items-center justify-center mb-4 ${bg}`}>
                  <Icon className={`w-5 h-5 ${color}`} />
                </div>
                <h3 className="text-base font-semibold text-white mb-2">{title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Tech Stack */}
      <section className="py-16 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-center text-2xl font-bold text-white mb-10">Under the Hood</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {TECH.map(({ label, value }) => (
              <div key={label} className="rounded-xl bg-[#182234] border border-white/5 px-5 py-4">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">{label}</p>
                <p className="text-sm font-semibold text-cyan-300">{value}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Vision */}
      <section className="px-6 pb-20">
        <div className="max-w-3xl mx-auto rounded-2xl border border-primary/20 bg-primary/[0.06] p-10 text-center">
          <h2 className="text-2xl font-bold text-white mb-4">Our vision</h2>
          <p className="text-slate-300 leading-7 text-base">
            Every SME deserves enterprise-grade infrastructure. We unify AI-powered development,
            secure cross-border connectivity, and intelligent automation into a single platform  
            so founders and teams can build fast, connect globally, and operate with confidence
            across China, ASEAN, and beyond.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 px-6 border-t border-white/5">
        <div className="max-w-xl mx-auto text-center">
          <h3 className="text-xl font-bold text-white mb-3">Work with us</h3>
          <p className="text-slate-400 text-sm mb-6">
            We're building the future of AI-powered SME infrastructure   reach out to learn more or explore partnership opportunities.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              to="/contact"
              className="inline-flex items-center text-sm font-medium text-slate-300 hover:text-white border border-white/10 hover:border-white/20 px-5 py-2.5 rounded-lg transition-all"
            >
              Get in touch
            </Link>
            <a
              href="https://www.linkedin.com/company/ecgai"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center text-sm font-medium text-slate-400 hover:text-white transition-colors"
            >
              Follow us on LinkedIn →
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

