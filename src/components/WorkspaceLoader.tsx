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
  /** Real loading milestones — drive the step index instead of a fake timer. */
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
  // Derive the active step index directly from real milestones. Falls back
  // to a timer only when milestones are not provided (backward compat).
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

  // Fake-progress fallback timer (only when milestones aren't provided)
  useEffect(() => {
    if (useMilestones || !visible) return;
    const id = setInterval(() => {
      setTimerStep((s) => (s < STEPS.length - 2 ? s + 1 : s));
    }, 700);
    return () => clearInterval(id);
  }, [useMilestones, visible]);

  const activeStep = useMilestones ? milestoneStep : timerStep;

  // When workspace finishes loading, jump to final step and fade out
  useEffect(() => {
    if (!visible) {
      const t = setTimeout(() => setLeaving(true), 120);
      return () => clearTimeout(t);
    }
  }, [visible]);

  if (leaving && !visible) return null;

  // Rail fill: line segment covers every *completed* step's midpoint through
  // the active step's midpoint, so it reads as "progress so far" rather than
  // stopping short at the last done step.
  const railPercent = STEPS.length > 1 ? (activeStep / (STEPS.length - 1)) * 100 : 0;

  return (
    <div
      className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[hsl(var(--workspace-surface-recessed))] transition-opacity duration-500 ${!visible ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
    >
      {/* Subtle radial background — brand primary/accent, not a generic indigo */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_35%,hsl(var(--primary)/0.07),transparent)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_30%_at_50%_85%,hsl(var(--accent)/0.05),transparent)]" />
      </div>

      {/* Grid dot pattern */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.018]"
        style={{ backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.8) 1px, transparent 1px)', backgroundSize: '28px 28px' }}
      />

      <div className="relative z-10 flex flex-col items-center w-full max-w-[320px] px-6 gap-9">

        {/* Brand mark */}
        <div className="flex flex-col items-center gap-3.5">
          <div className="relative w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center shadow-glow-accent">
            <img src={ecgLogo} alt="eCG" className="w-6 h-6 object-contain" />
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[hsl(var(--primary))]/80 animate-ping" />
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[hsl(var(--primary))]" />
          </div>

          <div className="text-center">
            <p className="text-[11px] font-medium tracking-[0.2em] text-white/25 uppercase mb-1">EcomGear</p>
            {projectName ? (
              <p className="font-['Fraunces'] text-[16px] font-semibold text-white/80 leading-tight truncate max-w-[240px]">{projectName}</p>
            ) : (
              <div className="h-4 w-28 rounded bg-white/[0.06] animate-pulse mx-auto" />
            )}
          </div>
        </div>

        {/* Steps — single connected rail, one progress signal instead of three */}
        <div className="relative w-full pl-0.5">
          <div className="absolute left-[5px] top-1.5 bottom-1.5 w-px bg-white/[0.08]" />
          <div
            className="absolute left-[5px] top-1.5 w-px bg-gradient-to-b from-[hsl(var(--primary))] to-[hsl(var(--accent))] transition-[height] duration-500 ease-out"
            style={{ height: `${railPercent}%` }}
          />

          <div className="space-y-4">
            {STEPS.map((step, i) => {
              const done   = i < activeStep;
              const active = i === activeStep;

              return (
                <div key={step.id} className="relative flex items-center gap-3.5 pl-0.5">
                  <div className={`relative z-10 shrink-0 w-2.5 h-2.5 rounded-full transition-all duration-300 ${
                    done   ? 'bg-[hsl(var(--primary))]' :
                    active ? 'bg-[hsl(var(--primary))] animate-pulse ring-4 ring-[hsl(var(--primary)/0.15)]' :
                             'bg-white/10'
                  }`}>
                    {done && <Check className="absolute -inset-[3px] w-4 h-4 text-[hsl(var(--workspace-surface-recessed))]" strokeWidth={3} />}
                  </div>

                  <span className={`flex-1 min-w-0 text-[12.5px] transition-colors duration-300 ${
                    done   ? 'text-white/30' :
                    active ? 'text-white/80 font-medium' :
                             'text-white/20'
                  }`}>
                    {step.label}
                    {active && step.id === 'files' && fileCount != null && fileCount > 0 && (
                      <span className="ml-1.5 text-[hsl(var(--primary)/0.75)] text-[11px]">({fileCount} files)</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
