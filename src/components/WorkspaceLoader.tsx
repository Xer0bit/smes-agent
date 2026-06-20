import { useEffect, useRef, useState } from 'react';
import { Boxes, Check } from 'lucide-react';

interface Step {
  id: string;
  label: string;
  detail?: string;
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
}

export function WorkspaceLoader({ projectName, fileCount, visible }: WorkspaceLoaderProps) {
  const [activeStep, setActiveStep] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Advance steps automatically until the last one
  useEffect(() => {
    if (!visible) return;
    timerRef.current = setInterval(() => {
      setActiveStep(s => (s < STEPS.length - 2 ? s + 1 : s));
    }, 700);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [visible]);

  // When workspace finishes loading, jump to final step and fade out
  useEffect(() => {
    if (!visible) {
      if (timerRef.current) clearInterval(timerRef.current);
      setActiveStep(STEPS.length - 1);
      const t = setTimeout(() => setLeaving(true), 120);
      return () => clearTimeout(t);
    }
  }, [visible]);

  if (leaving && !visible) return null;

  return (
    <div
      className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#09090b] transition-opacity duration-500 ${!visible ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
    >
      {/* Subtle radial background */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_40%,rgba(99,102,241,0.07),transparent)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_30%_at_50%_80%,rgba(139,92,246,0.04),transparent)]" />
      </div>

      {/* Grid dot pattern */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.018]"
        style={{ backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.8) 1px, transparent 1px)', backgroundSize: '28px 28px' }}
      />

      <div className="relative z-10 flex flex-col items-center w-full max-w-[320px] px-6 gap-10">

        {/* Brand mark */}
        <div className="flex flex-col items-center gap-3">
          <div className="relative w-11 h-11 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center shadow-[0_0_32px_rgba(99,102,241,0.15)]">
            <Boxes className="w-5 h-5 text-white/50" />
            {/* Corner pulse */}
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-indigo-400/80 animate-ping" />
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-indigo-400" />
          </div>

          <div className="text-center">
            <p className="text-[11px] font-medium tracking-widest text-white/20 uppercase mb-0.5">EcomGear</p>
            {projectName ? (
              <p className="text-[14px] font-semibold text-white/70 leading-tight truncate max-w-[240px]">{projectName}</p>
            ) : (
              <div className="h-4 w-28 rounded bg-white/[0.06] animate-pulse mx-auto" />
            )}
          </div>
        </div>

        {/* Steps */}
        <div className="w-full space-y-3">
          {STEPS.map((step, i) => {
            const done   = i < activeStep;
            const active = i === activeStep;
            const future = i > activeStep;

            return (
              <div key={step.id} className="flex items-center gap-3">
                {/* Indicator */}
                <div className={`shrink-0 w-4 h-4 rounded-full flex items-center justify-center transition-all duration-300 ${
                  done   ? 'bg-emerald-500/20 border border-emerald-500/40' :
                  active ? 'bg-indigo-500/20 border border-indigo-500/50' :
                           'bg-white/[0.04] border border-white/[0.08]'
                }`}>
                  {done ? (
                    <Check className="w-2.5 h-2.5 text-emerald-400" />
                  ) : active ? (
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                  ) : (
                    <span className="w-1 h-1 rounded-full bg-white/10" />
                  )}
                </div>

                {/* Label */}
                <div className="flex-1 min-w-0">
                  <span className={`text-[12px] transition-colors duration-300 ${
                    done   ? 'text-white/25' :
                    active ? 'text-white/75 font-medium' :
                             'text-white/15'
                  }`}>
                    {step.label}
                    {active && step.id === 'files' && fileCount != null && fileCount > 0 && (
                      <span className="ml-1.5 text-indigo-400/70 text-[11px]">({fileCount} files)</span>
                    )}
                  </span>
                </div>

                {/* Timing shimmer for active step */}
                {active && (
                  <div className="shrink-0 w-12 h-px bg-gradient-to-r from-indigo-500/40 via-violet-500/60 to-transparent rounded-full animate-[shimmer_1.2s_ease-in-out_infinite]" />
                )}
              </div>
            );
          })}
        </div>

        {/* Progress bar */}
        <div className="w-full">
          <div className="w-full h-px bg-white/[0.06] rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-500/70 via-violet-500/70 to-indigo-400/50 rounded-full transition-all duration-700 ease-out"
              style={{ width: `${Math.round(((activeStep + 1) / STEPS.length) * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-center text-[10px] text-white/15 tabular-nums">
            {Math.round(((activeStep + 1) / STEPS.length) * 100)}%
          </p>
        </div>
      </div>
    </div>
  );
}
