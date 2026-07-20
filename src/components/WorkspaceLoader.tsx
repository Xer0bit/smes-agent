import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import ecgLogo from '@/assets/ecg-logo.png';

interface Step {
  id: string;
  label: string;
}

const STEPS: Step[] = [
  { id: 'auth',    label: 'Verifying session' },
  { id: 'project', label: 'Loading project data' },
  { id: 'files',   label: 'Restoring workspace files' },
  { id: 'preview', label: 'Warming up preview engine' },
  { id: 'ready',   label: 'Workspace ready' },
];

interface WorkspaceLoaderProps {
  projectName?: string | null;
  fileCount?: number;
  visible: boolean;
  authResolved?: boolean;
  projectFetched?: boolean;
  filesRestored?: boolean;
  previewFirstPaint?: boolean;
}

export function WorkspaceLoader({
  projectName,
  fileCount,
  visible,
  authResolved,
  projectFetched,
  filesRestored,
  previewFirstPaint,
}: WorkspaceLoaderProps) {
  const milestones = [authResolved, projectFetched, filesRestored, previewFirstPaint, visible === false];
  const useMilestones = milestones.some((m) => m !== undefined);

  const milestoneStep = (() => {
    if (!useMilestones) return -1;
    for (let i = 0; i < milestones.length; i++) {
      if (!milestones[i]) return i;
    }
    return STEPS.length - 1;
  })();

  const [timerStep, setTimerStep] = useState(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (useMilestones || !visible) return;
    const id = setInterval(() => {
      setTimerStep((s) => (s < STEPS.length - 2 ? s + 1 : s));
    }, 700);
    return () => clearInterval(id);
  }, [useMilestones, visible]);

  const activeStep = useMilestones ? milestoneStep : timerStep;
  const complete = activeStep >= STEPS.length - 1;
  const pct = STEPS.length > 1 ? Math.round((activeStep / (STEPS.length - 1)) * 100) : 0;

  // Handles both directions: fade out on hide, and reset so the loader
  // can be shown again later instead of being permanently unmountable.
  useEffect(() => {
    if (!visible) {
      const t = setTimeout(() => setLeaving(true), 120);
      return () => clearTimeout(t);
    }
    setLeaving(false);
  }, [visible]);

  if (leaving && !visible) return null;

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-[hsl(var(--workspace-surface-recessed))] transition-all duration-500 ${!visible ? 'opacity-0 scale-[0.97] pointer-events-none' : 'opacity-100 scale-100'}`}
    >
      {/* Ambient glow   single light source, breathing */}
      <div className="absolute left-1/2 top-[15%] -translate-x-1/2 w-[600px] h-[400px] pointer-events-none animate-loader-breathe"
        style={{ background: 'radial-gradient(ellipse, rgba(52,211,153,0.06) 0%, transparent 70%)' }} />

      {/* Grain texture */}
      <div
        className="absolute inset-[-50%] w-[200%] h-[200%] pointer-events-none opacity-[0.028]"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
          backgroundSize: '180px 180px',
        }}
      />

      {/* Card */}
      <div className="relative z-10 w-[340px] rounded-2xl border border-white/[0.06] bg-[hsl(var(--workspace-surface))] px-7 pt-8 pb-7 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6),0_0_120px_-40px_rgba(52,211,153,0.06)]">
        {/* Top accent line */}
        <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-emerald-400/20 to-transparent" />

        {/* Header */}
        <div className="flex items-center gap-3.5 mb-7">
          <div className="relative w-10 h-10 rounded-[10px] bg-[hsl(var(--workspace-surface-recessed))] border border-white/[0.06] grid place-items-center shrink-0">
            <span className="absolute -inset-[3px] rounded-[13px] border border-emerald-400/15 animate-loader-ring" />
            <img src={ecgLogo} alt="eCG" className="w-[18px] h-[18px] object-contain" />
          </div>

          <div className="min-w-0">
            <div className="text-[10px] font-medium tracking-[0.12em] uppercase text-white/20 mb-0.5">EcomGear</div>
            {projectName ? (
              <p className="font-['Fraunces'] text-[17px] font-normal text-white/85 truncate leading-tight">{projectName}</p>
            ) : (
              <div className="h-[14px] w-[100px] rounded bg-white/[0.05] mt-0.5" />
            )}
          </div>
        </div>

        <div className="h-px bg-white/[0.06] mb-6" />

        {/* Progress bar */}
        <div className="h-[2px] rounded-full bg-white/[0.04] overflow-hidden mb-[22px]">
          <div className="h-full rounded-full bg-emerald-400 transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]" style={{ width: `${pct}%` }} />
        </div>

        {/* Steps */}
        <div className="flex flex-col">
          {STEPS.map((step, i) => {
            const done = i < activeStep;
            const active = i === activeStep;
            return (
              <div key={step.id} className="relative flex items-center gap-3 py-[9px]">
                {i < STEPS.length - 1 && (
                  <span className={`absolute left-[6.5px] top-7 bottom-[-1px] w-px transition-colors duration-300 ${done ? 'bg-emerald-400/15' : 'bg-white/[0.06]'}`} />
                )}

                <div className={`relative shrink-0 w-3.5 h-3.5 rounded-full grid place-items-center border transition-all duration-300 ${
                  done ? 'border-emerald-400 bg-emerald-400' :
                  active ? 'border-emerald-400 bg-emerald-400/10 shadow-[0_0_12px_rgba(52,211,153,0.15)]' :
                  'border-white/10 bg-transparent'
                }`}>
                  {active && (
                    <span className="absolute inset-[2px] rounded-full border-[1.5px] border-transparent border-t-emerald-400 animate-spin" />
                  )}
                  <Check
                    className={`w-2 h-2 text-[hsl(var(--workspace-surface))] transition-all duration-200 ${done ? 'opacity-100 scale-100' : 'opacity-0 scale-[0.4]'}`}
                    strokeWidth={3.5}
                  />
                </div>

                <span className={`text-[12.5px] leading-none transition-colors duration-300 ${
                  done ? 'text-white/30' : active ? 'text-white/85 font-medium' : 'text-white/20'
                }`}>
                  {step.label}
                  {active && step.id === 'files' && fileCount != null && fileCount > 0 && (
                    <span className="ml-1.5 text-emerald-400/75 text-[11px]">({fileCount} files)</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between mt-6 pt-4 border-t border-white/[0.06]">
          <div className="flex items-center gap-1.5 text-[11px] text-white/20">
            <span className="w-[5px] h-[5px] rounded-full bg-emerald-400 animate-loader-pulse-dot" />
            <span>{complete ? 'Complete' : STEPS[Math.max(activeStep, 0)]?.label.replace(/^(.)/, (c) => c.toLowerCase())}</span>
          </div>
          <span className={`text-[11px] font-medium tabular-nums transition-colors duration-300 ${complete ? 'text-emerald-400' : 'text-white/45'}`}>{pct}%</span>
        </div>
      </div>
    </div>
  );
}
