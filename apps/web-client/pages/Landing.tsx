import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import {
  Sparkles,
  Cpu,
  Rocket,
  ArrowRight,
  Shield,
  Terminal,
  Code2,
  Zap,
  Layers,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';

export default function Landing() {
  const navigate = useNavigate();
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate('/dashboard', { replace: true });
      } else {
        setCheckingAuth(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
        navigate('/dashboard', { replace: true });
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [navigate]);

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-[#09090b] flex items-center justify-center text-slate-400">
        <div className="h-6 w-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#09090b] text-slate-100 font-sans selection:bg-indigo-500 selection:text-white relative overflow-hidden">
      
      {/* Background Radial Glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-gradient-to-b from-indigo-600/20 via-purple-600/10 to-transparent blur-3xl pointer-events-none -z-10" />

      {/* Navigation Header */}
      <header className="border-b border-zinc-800/80 bg-[#09090b]/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => navigate('/')}>
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
              eCG
            </div>
            <span className="font-bold text-xl tracking-tight text-white">eComGear</span>
          </div>

          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              onClick={() => navigate('/auth')}
              className="text-zinc-300 hover:text-white hover:bg-zinc-800/60 rounded-xl"
            >
              Sign In
            </Button>
            <Button
              onClick={() => navigate('/auth')}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-xl px-4 shadow-lg shadow-indigo-600/25 transition-all"
            >
              Get Started
            </Button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative pt-20 pb-24 md:pt-32 md:pb-36 px-6">
        <div className="max-w-5xl mx-auto text-center space-y-8">
          
          {/* Announcement pill */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-xs font-semibold tracking-wide uppercase shadow-sm">
            <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
            <span>Next-Gen Autonomous AI Coding Engine</span>
          </div>

          {/* Main Headline */}
          <h1 className="text-4xl md:text-6xl lg:text-7xl font-extrabold tracking-tight text-white leading-[1.1]">
            The AI IDE that <br className="hidden sm:inline" />
            <span className="bg-gradient-to-r from-indigo-400 via-purple-300 to-pink-400 bg-clip-text text-transparent">
              actually builds and deploys.
            </span>
          </h1>

          {/* Subheadline */}
          <p className="max-w-2xl mx-auto text-lg md:text-xl text-zinc-400 font-normal leading-relaxed">
            Generate, refactor, and test full-stack applications in isolated MicroVM sandboxing environments, then launch live to Vercel in one click.
          </p>

          {/* Hero CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <Button
              size="lg"
              onClick={() => navigate('/auth')}
              className="w-full sm:w-auto h-12 px-8 rounded-xl bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold shadow-xl shadow-indigo-500/25 transition-all text-base flex items-center justify-center gap-2"
            >
              <span>Start Building for Free</span>
              <ArrowRight className="h-5 w-5" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => navigate('/features')}
              className="w-full sm:w-auto h-12 px-8 rounded-xl border-zinc-800 bg-zinc-900/80 text-zinc-300 hover:bg-zinc-800 hover:text-white transition-all text-base"
            >
              View Documentation
            </Button>
          </div>

          {/* Mock Interactive Code Window */}
          <div className="pt-12 max-w-4xl mx-auto">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/90 shadow-2xl shadow-indigo-950/40 overflow-hidden text-left">
              <div className="bg-zinc-900/80 border-b border-zinc-800 px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-3 w-3 rounded-full bg-red-500/80" />
                  <div className="h-3 w-3 rounded-full bg-yellow-500/80" />
                  <div className="h-3 w-3 rounded-full bg-green-500/80" />
                  <span className="ml-2 text-xs font-mono text-zinc-500">ecomgear-agent-stream.ts</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-indigo-400 font-mono">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                  MicroVM Active (Port 3000)
                </div>
              </div>
              <div className="p-6 font-mono text-xs md:text-sm text-zinc-300 space-y-3 bg-[#0d0d11]">
                <p className="text-zinc-500">// AI Agent Stream Initializing...</p>
                <p className="text-indigo-400">
                  <span className="text-purple-400">const</span> workspace = <span className="text-purple-400">await</span> eComGear.<span className="text-blue-400">initSandbox</span>(&#123; <span className="text-amber-300">tier</span>: <span className="text-emerald-400">'pro'</span> &#125;);
                </p>
                <p className="text-zinc-300">
                  ⚡ Refactoring <span className="text-amber-300">src/App.tsx</span> with multi-modal vision context...
                </p>
                <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-500/20 text-emerald-300 flex items-center justify-between">
                  <span>✔ Vercel Deployment live: https://ecomgear-app.vercel.app</span>
                  <ExternalLink className="h-4 w-4 shrink-0" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Core Feature Pillars Grid */}
      <section className="py-20 border-t border-zinc-800/60 bg-zinc-950/40 px-6">
        <div className="max-w-6xl mx-auto space-y-16">
          <div className="text-center space-y-4">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-white">
              Built for Modern Developers & AI Builders
            </h2>
            <p className="text-zinc-400 max-w-xl mx-auto text-base">
              Everything you need to turn prompts and visual mockups into deployed production code.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            
            {/* Pillar 1 */}
            <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-8 space-y-4 hover:border-indigo-500/40 hover:shadow-xl hover:shadow-indigo-500/5 transition-all group">
              <div className="h-12 w-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 group-hover:scale-110 transition-transform">
                <Sparkles className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-bold text-white group-hover:text-indigo-300 transition-colors">
                1. Multi-Modal Vision AI
              </h3>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Drag and drop UI wireframes, Figma screenshots, or design assets directly into the chat prompt. The vision pipeline parses structure and renders production UI immediately.
              </p>
            </div>

            {/* Pillar 2 */}
            <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-8 space-y-4 hover:border-indigo-500/40 hover:shadow-xl hover:shadow-indigo-500/5 transition-all group">
              <div className="h-12 w-12 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 group-hover:scale-110 transition-transform">
                <Cpu className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-bold text-white group-hover:text-purple-300 transition-colors">
                2. MicroVM Sandboxing
              </h3>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Zero local setup. Code runs in isolated Firecracker MicroVM containers with full Node.js, hot-module replacement, and AST safeguard checks.
              </p>
            </div>

            {/* Pillar 3 */}
            <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-8 space-y-4 hover:border-indigo-500/40 hover:shadow-xl hover:shadow-indigo-500/5 transition-all group">
              <div className="h-12 w-12 rounded-xl bg-pink-500/10 border border-pink-500/20 flex items-center justify-center text-pink-400 group-hover:scale-110 transition-transform">
                <Rocket className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-bold text-white group-hover:text-pink-300 transition-colors">
                3. One-Click Vercel Deploy
              </h3>
              <p className="text-zinc-400 text-sm leading-relaxed">
                Publish your sandbox projects instantly. Our Vercel deployment pipeline compiles your generated codebase and returns a live production URL in seconds.
              </p>
            </div>

          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800/80 py-10 px-6 text-center text-xs text-zinc-500">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-indigo-600 flex items-center justify-center font-bold text-white text-[10px]">
              eCG
            </div>
            <span className="font-semibold text-zinc-400 text-sm">eComGear Inc.</span>
          </div>
          <p>© {new Date().getFullYear()} eComGear. All rights reserved. Autonomous AI IDE Platform.</p>
        </div>
      </footer>

    </div>
  );
}
