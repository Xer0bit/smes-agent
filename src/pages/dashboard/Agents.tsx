import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';
import {
  Bot,
  Workflow,
  Zap,
  Globe,
  ShoppingCart,
  PenTool,
  BarChart3,
  Shield,
  Clock,
  ChevronRight,
  Sparkles,
  ArrowRight,
  Lock,
  Play,
  MessageSquare,
  Layers,
  GitBranch,
  Database,
  Mail,
  FileText,
  Search,
  Cpu,
  PlugZap,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

/* ─────────────────────────── types ─────────────────────────── */

interface AgentCard {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  status: 'active' | 'coming-soon';
  category: string;
  accent: string;
  glowColor: string;
}

interface WorkflowNode {
  id: string;
  label: string;
  icon: React.ElementType;
  type: 'trigger' | 'action' | 'condition' | 'output';
  x: number;
  y: number;
}

/* ─────────────────────────── data ──────────────────────────── */

const AGENTS: AgentCard[] = [
  {
    id: 'website-builder',
    title: 'Website Builder Agent',
    description: 'Generate full websites from a text brief. React + Tailwind with live preview and one-click publish.',
    icon: Globe,
    status: 'active',
    category: 'Generation',
    accent: 'from-cyan-500/20 to-blue-500/5',
    glowColor: 'shadow-cyan-500/15',
  },
  {
    id: 'integration-connectivity',
    title: 'Integration & Connectivity Agent',
    description: 'Handle connectors, external APIs, webhooks, database connectivity, and deployment-time integration planning.',
    icon: PlugZap,
    status: 'active',
    category: 'Integration',
    accent: 'from-indigo-500/20 to-cyan-500/5',
    glowColor: 'shadow-indigo-500/15',
  },
  {
    id: 'ecommerce',
    title: 'E-commerce Agent',
    description: 'Build complete online stores with product catalogs, cart, checkout, and payment integration.',
    icon: ShoppingCart,
    status: 'coming-soon',
    category: 'Generation',
    accent: 'from-emerald-500/20 to-green-500/5',
    glowColor: 'shadow-emerald-500/15',
  },
  {
    id: 'content-writer',
    title: 'Content Writer',
    description: 'Auto-generate SEO-optimized copy, blog posts, and product descriptions for your sites.',
    icon: PenTool,
    status: 'coming-soon',
    category: 'Content',
    accent: 'from-violet-500/20 to-purple-500/5',
    glowColor: 'shadow-violet-500/15',
  },
  {
    id: 'analytics',
    title: 'Analytics Agent',
    description: 'Monitor traffic, conversions, and user behavior. Get AI-powered insights and recommendations.',
    icon: BarChart3,
    status: 'coming-soon',
    category: 'Intelligence',
    accent: 'from-amber-500/20 to-orange-500/5',
    glowColor: 'shadow-amber-500/15',
  },
  {
    id: 'seo-optimizer',
    title: 'SEO Optimizer',
    description: 'Audit pages for SEO, fix meta tags, generate sitemaps, and improve search rankings automatically.',
    icon: Search,
    status: 'coming-soon',
    category: 'Optimization',
    accent: 'from-rose-500/20 to-pink-500/5',
    glowColor: 'shadow-rose-500/15',
  },
  {
    id: 'security-scanner',
    title: 'Security Scanner',
    description: 'Continuous vulnerability scanning, dependency audits, and automated security patching.',
    icon: Shield,
    status: 'coming-soon',
    category: 'Security',
    accent: 'from-red-500/20 to-rose-500/5',
    glowColor: 'shadow-red-500/15',
  },
  {
    id: 'email-automation',
    title: 'Email Automation',
    description: 'Design email templates, set up drip campaigns, and automate customer communication flows.',
    icon: Mail,
    status: 'coming-soon',
    category: 'Automation',
    accent: 'from-sky-500/20 to-blue-500/5',
    glowColor: 'shadow-sky-500/15',
  },
  {
    id: 'form-builder',
    title: 'Form & Survey Builder',
    description: 'Create smart forms with conditional logic, validation, and response analytics. No code required.',
    icon: FileText,
    status: 'coming-soon',
    category: 'Generation',
    accent: 'from-teal-500/20 to-cyan-500/5',
    glowColor: 'shadow-teal-500/15',
  },
];

const WORKFLOW_NODES: WorkflowNode[] = [
  { id: '1', label: 'User Brief', icon: MessageSquare, type: 'trigger', x: 60, y: 80 },
  { id: '2', label: 'AI Transform', icon: Cpu, type: 'action', x: 260, y: 50 },
  { id: '3', label: 'Validate', icon: GitBranch, type: 'condition', x: 460, y: 80 },
  { id: '4', label: 'Build & Deploy', icon: Layers, type: 'action', x: 660, y: 50 },
  { id: '5', label: 'Live Site', icon: Globe, type: 'output', x: 860, y: 80 },
];

const NODE_STYLES: Record<string, { bg: string; border: string; text: string }> = {
  trigger: { bg: 'bg-violet-500/10', border: 'border-violet-500/30', text: 'text-violet-400' },
  action: { bg: 'bg-cyan-500/10', border: 'border-cyan-500/30', text: 'text-cyan-400' },
  condition: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400' },
  output: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400' },
};

/* ──────────────────────── sub-components ──────────────────── */

function WorkflowCanvas() {
  return (
    <Card className="relative overflow-hidden rounded-none border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.025),rgba(255,255,255,0.01))] shadow-[0_16px_48px_rgba(3,12,27,0.25)]">
      {/* dot grid background — n8n style */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      />
      <CardContent className="relative p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-none border border-white/10 bg-white/5">
              <Workflow className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Agent Pipeline</h3>
              <p className="text-[11px] text-muted-foreground">How your websites get built</p>
            </div>
          </div>
          <Badge variant="outline" className="rounded-none border-primary/20 bg-primary/5 text-[10px] text-primary">
            <Play className="mr-1 h-2.5 w-2.5" />
            Live
          </Badge>
        </div>

        {/* workflow visualization */}
        <div className="relative min-h-[140px] overflow-x-auto">
          <svg className="absolute inset-0 h-full w-full" style={{ minWidth: 1000 }}>
            {/* connection lines */}
            {WORKFLOW_NODES.slice(0, -1).map((node, i) => {
              const next = WORKFLOW_NODES[i + 1];
              return (
                <g key={`line-${node.id}`}>
                  <line
                    x1={node.x + 100}
                    y1={node.y + 28}
                    x2={next.x}
                    y2={next.y + 28}
                    stroke="url(#lineGrad)"
                    strokeWidth="2"
                    strokeDasharray="6 4"
                    className="animate-pulse"
                  />
                  <circle
                    cx={(node.x + 100 + next.x) / 2}
                    cy={(node.y + next.y) / 2 + 28}
                    r="3"
                    className="fill-primary/50"
                  />
                </g>
              );
            })}
            <defs>
              <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.4" />
                <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity="0.4" />
              </linearGradient>
            </defs>
          </svg>

          <div className="relative" style={{ minWidth: 1000, minHeight: 140 }}>
            {WORKFLOW_NODES.map((node) => {
              const style = NODE_STYLES[node.type];
              const Icon = node.icon;
              return (
                <div
                  key={node.id}
                  className={`absolute flex items-center gap-2.5 border px-4 py-2.5 transition-all hover:scale-105 hover:shadow-lg ${style.bg} ${style.border}`}
                  style={{ left: node.x, top: node.y, width: 120 }}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${style.text}`} />
                  <span className="text-xs font-medium whitespace-nowrap">{node.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AgentCardItem({ agent, onClick }: { agent: AgentCard; onClick: () => void }) {
  const Icon = agent.icon;
  const isActive = agent.status === 'active';

  return (
    <Card
      className={`group relative flex h-full cursor-pointer flex-col overflow-hidden rounded-none border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))] transition-all duration-300 hover:border-white/15 hover:shadow-[0_20px_60px_rgba(3,12,27,0.35)] ${isActive ? '' : 'opacity-80'}`}
      onClick={onClick}
    >
      {/* glow accent top */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-br ${agent.accent}`} />

      {/* coming soon overlay */}
      {!isActive && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/40 backdrop-blur-[2px]">
          <div className="flex items-center gap-2 border border-white/10 bg-card/90 px-4 py-2 shadow-xl">
            <Lock className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Coming Soon</span>
          </div>
        </div>
      )}

      <CardContent className="relative flex flex-1 flex-col gap-4 p-5 pt-6">
        <div className="flex items-start justify-between">
          <div className={`flex h-11 w-11 items-center justify-center border border-white/10 bg-white/5 shadow-lg ${agent.glowColor}`}>
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <Badge
            variant="outline"
            className={`rounded-none text-[10px] ${
              isActive
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'border-white/10 bg-white/5 text-muted-foreground'
            }`}
          >
            {isActive ? 'Active' : 'Soon'}
          </Badge>
        </div>

        <div className="flex-1 space-y-1.5">
          <h3 className="text-sm font-semibold">{agent.title}</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">{agent.description}</p>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {agent.category}
          </span>
          {isActive && (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ──────────────────────── Quick Stats ─────────────────────── */

function QuickStats() {
  const stats = [
    { label: 'Agents Available', value: '2', sub: 'of 9', icon: Bot, color: 'text-cyan-400' },
    { label: 'Workflows Run', value: '—', sub: 'start building', icon: Workflow, color: 'text-violet-400' },
    { label: 'Sites Generated', value: '—', sub: 'this month', icon: Globe, color: 'text-emerald-400' },
    { label: 'Avg Build Time', value: '~30s', sub: 'per site', icon: Clock, color: 'text-amber-400' },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((s) => {
        const Icon = s.icon;
        return (
          <Card key={s.label} className="rounded-none border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01))]">
            <CardContent className="flex items-center gap-3 p-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-white/8 bg-white/5">
                <Icon className={`h-4 w-4 ${s.color}`} />
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-lg font-bold tabular-nums">{s.value}</span>
                  <span className="text-[10px] text-muted-foreground">{s.sub}</span>
                </div>
                <p className="truncate text-[10px] text-muted-foreground">{s.label}</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/* ──────────────────────── main export ─────────────────────── */

export default function DashboardAgents() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'active' | 'coming-soon'>('all');

  const filtered = filter === 'all' ? AGENTS : AGENTS.filter((a) => a.status === filter);

  return (
    <div className="p-6 sm:p-8">
      <DashboardPageHeader
        title="Agents"
        description="AI-powered agents that build, optimize, and manage your web projects. Think of each agent as a specialist on your team."
        actions={
          <Button
            className="rounded-none border-white/10 bg-primary/10 text-primary hover:bg-primary/20"
            variant="outline"
            onClick={() => navigate('/dashboard/projects')}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            Start Building
          </Button>
        }
      />

      {/* quick stats row */}
      <QuickStats />

      {/* pipeline canvas — n8n-style */}
      <div className="mt-6">
        <WorkflowCanvas />
      </div>

      {/* filter tabs */}
      <div className="mt-8 flex items-center gap-2">
        {(['all', 'active', 'coming-soon'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`border px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === f
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-white/8 bg-white/[0.02] text-muted-foreground hover:bg-white/5'
            }`}
          >
            {f === 'all' ? 'All Agents' : f === 'active' ? 'Active' : 'Coming Soon'}
          </button>
        ))}
        <span className="ml-2 text-[11px] text-muted-foreground">{filtered.length} agent{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* agent grid */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {filtered.map((agent) => (
          <AgentCardItem
            key={agent.id}
            agent={agent}
            onClick={() => {
              if (agent.status === 'active') navigate('/dashboard/projects');
            }}
          />
        ))}
      </div>

      {/* bottom CTA */}
      <Card className="mt-8 rounded-none border-white/8 bg-[linear-gradient(135deg,rgba(0,209,178,0.06),rgba(138,43,226,0.06))]">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center sm:flex-row sm:text-left">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center border border-primary/20 bg-primary/10">
            <Zap className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold">More agents are on the way</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              We're building a full ecosystem of AI agents — from SEO optimization to email automation.
              Upgrade your plan to unlock agents as they launch.
            </p>
          </div>
          <Button variant="outline" className="shrink-0 rounded-none border-white/10 bg-white/5" onClick={() => navigate('/dashboard/settings')}>
            View Plans
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
