import { useEffect, useState } from 'react';
import { Check, Wrench, RotateCcw, ListChecks, Database, History, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * What the preview pane shows when there is no app to show yet.
 *
 * It used to be a spinner, a looping video, or a full-pane amber warning,
 * depending on which of four states the pane was in. All of them read as
 * "something is wrong" during the minutes a first build takes. This is one
 * surface for every no-frame state: where the run is in the pipeline, what
 * the agent is doing right now, which parts of the app are being built, and
 * a rotating tip. A build problem appears as a notice with its actions, not
 * as the whole pane.
 *
 * No spinners: progress is the text changing.
 */

export interface RunProgress {
  generating: boolean;
  status: string;
  steps: string[];
}

export interface PreviewIssue {
  title: string;
  description: string;
  onRepair?: () => void;
  onRetry?: () => void;
}

interface PreviewPlaceholderProps {
  progress?: RunProgress;
  previewStatus: 'pending' | 'building' | 'ready' | 'failed';
  installingDependency?: boolean;
  issue?: PreviewIssue;
}

const STAGES = ['Plan', 'Build', 'Check', 'Preview', 'Publish'] as const;

const TIPS = [
  'Ask for one feature at a time. Smaller requests land faster and cost less.',
  'Use Plan mode to talk a feature through before anything is built.',
  'Upload a spec, a screenshot or a brand file: the agent keeps its content as project knowledge.',
  'Settings → Knowledge shows everything the agent remembers. Archive what it should stop using.',
  'Click Inspect, then an element in the preview, to scope your next request to exactly that part.',
  'Logins live in your own database. The agent writes them as edge functions with hashed passwords.',
  'Undo any change from the message that made it. Every run is a revision you can roll back to.',
  'Publish puts the app on its own address; connect a custom domain from Settings → Domains.',
];

function activeStage(progress: RunProgress | undefined, previewStatus: PreviewPlaceholderProps['previewStatus'], installing: boolean): number {
  if (previewStatus === 'building' || installing) return 3;
  if (!progress?.generating) return previewStatus === 'ready' ? 3 : 0;
  const s = progress.status.toLowerCase();
  if (/review|check|verif|test|build error/.test(s)) return 2;
  if (progress.steps.length > 0 || /build|writ|creat|updat|edit|install/.test(s)) return 1;
  return 0;
}

/** "Building src/pages/Cart.tsx..." -> "Cart page"; keep the phrase readable, not a path. */
function humanStep(label: string): string {
  const m = label.match(/^(Building|Updating|Removing|Renaming|Installing)\s+(.+?)(\.\.\.|…)?$/);
  if (!m) return label;
  return `${m[1]} ${m[2].replace(/\.(tsx?|jsx?|css|json|md)$/i, '')}`;
}

/** A browser window in which a page wireframe assembles itself; re-keyed every 9s to replay. */
function Scene({ cycle }: { cycle: number }) {
  const bar = (w: string, h: string, delay: string, tone = 'bg-white/[0.12]') => (
    <span className={cn('eg-bar rounded-md', tone)} style={{ width: w, height: h, animationDelay: delay }} />
  );
  return (
    <div key={cycle} className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-[#111114]">
      <div className="flex items-center gap-1.5 border-b border-white/[0.08] px-3 py-2.5">
        <span className="h-2 w-2 rounded-full bg-[#ff5f57]/80" /><span className="h-2 w-2 rounded-full bg-[#febc2e]/80" /><span className="h-2 w-2 rounded-full bg-[#28c840]/80" />
        <span className="ml-2 h-2 flex-1 rounded-full bg-white/[0.06]" />
      </div>
      <div className="eg-scene flex flex-col gap-3.5 p-4">
        <div className="flex items-center gap-2.5" style={{ animationDelay: '0.1s' }}>
          <span className="h-5 w-5 rounded-md bg-white/90" />
          {bar('70px', '8px', '0.25s')}
          <span className="flex-1" />
          {bar('40px', '8px', '0.35s')}
          {bar('40px', '8px', '0.45s')}
          <span className="eg-card h-5 w-16 rounded-full bg-white/90" style={{ animationDelay: '0.6s' }} />
        </div>
        <div className="mt-2 flex flex-col gap-2" style={{ animationDelay: '0.7s' }}>
          {bar('62%', '16px', '0.8s', 'bg-white/60')}
          {bar('44%', '16px', '1s', 'bg-white/60')}
          {bar('55%', '8px', '1.25s')}
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-2.5" style={{ animationDelay: '1.5s' }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="eg-card flex flex-col gap-1.5 rounded-lg border border-white/[0.08] p-2.5" style={{ animationDelay: `${1.6 + i * 0.18}s` }}>
              <span className="h-11 w-full rounded-md bg-white/[0.08]" />
              <span className="h-1.5 w-[70%] rounded bg-white/[0.12]" />
              <span className="h-1.5 w-[45%] rounded bg-white/[0.12]" />
            </div>
          ))}
        </div>
      </div>
      <svg className="eg-cursor absolute left-[60px] top-[70px] drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)]" width="16" height="18" viewBox="0 0 16 18" aria-hidden="true">
        <path d="M1 1l5.5 15 2.3-6.2L15 7.5z" fill="#fff" stroke="#0c0c0e" strokeWidth="1" />
      </svg>
    </div>
  );
}

export function PreviewPlaceholder({ progress, previewStatus, installingDependency = false, issue }: PreviewPlaceholderProps) {
  const [tip, setTip] = useState(0);
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    const a = setInterval(() => setTip((t) => (t + 1) % TIPS.length), 7000);
    const b = setInterval(() => setCycle((c) => c + 1), 9000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);

  const stage = activeStage(progress, previewStatus, installingDependency);
  const busy = Boolean(progress?.generating) || previewStatus === 'building' || installingDependency;
  const now = installingDependency
    ? 'Installing packages the app needs'
    : previewStatus === 'building'
      ? 'Starting the live preview'
      : progress?.generating
        ? (progress.status || 'Reading the project')
        : '';
  const recent = (progress?.steps ?? []).slice(-6).map(humanStep);

  return (
    <div className="h-full w-full overflow-y-auto bg-[#0c0c0e] text-white">
      <div className="mx-auto max-w-xl px-8 py-8 space-y-7">
        <div className="flex items-start justify-between gap-4">
          <div>
          <p className="text-[20px] font-semibold tracking-tight text-white/90">
            {busy ? 'Your app is being built' : issue ? 'The preview needs a fix' : 'No preview yet'}
          </p>
          <p className="mt-1 text-[13px] text-white/45">
            {busy
              ? 'The preview appears here the moment the first version can run.'
              : issue
                ? 'The last update did not build. Repair asks the agent to fix it.'
                : 'Describe what you want in the chat. The first version usually takes a few minutes.'}
          </p>
          </div>
          {busy && (
            <span className="mt-1 inline-flex shrink-0 items-center gap-1.5 text-[12px] text-white/45">
              <span className="eg-pulse h-1.5 w-1.5 rounded-full bg-emerald-300" /> building
            </span>
          )}
        </div>

        <Scene cycle={cycle} />

        {/* Pipeline */}
        <ol className="flex items-center gap-2">
          {STAGES.map((name, i) => {
            const done = i < stage;
            const active = i === stage && busy;
            return (
              <li key={name} className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-[12px]',
                    done ? 'text-white/60' : active ? 'text-white/90' : 'text-white/30',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded-full border text-[9px]',
                      done ? 'border-white/30 bg-white/10' : active ? 'eg-pulse border-white/70' : 'border-white/15',
                    )}
                  >
                    {done ? <Check className="h-2.5 w-2.5" /> : i + 1}
                  </span>
                  {name}
                </span>
                {i < STAGES.length - 1 && <span className="h-px w-4 bg-white/10" />}
              </li>
            );
          })}
        </ol>
        {busy && (
          <div className="relative -mt-4 h-0.5 overflow-hidden rounded bg-white/[0.06]">
            <div className="eg-sweep absolute inset-y-0 w-1/4 rounded bg-gradient-to-r from-transparent via-white/70 to-transparent" />
          </div>
        )}

        {/* Now */}
        {now && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-white/35">Now</p>
            <p className="mt-1 text-[13px] text-white/85">{now}</p>
            {recent.length > 0 && (
              <ul className="mt-3 space-y-1">
                {recent.map((s, i) => (
                  <li key={`${s}-${i}`} className="flex items-center gap-2 text-[12.5px] text-white/60">
                    <Check className="h-3 w-3 text-white/35" />
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Issue */}
        {issue && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3">
            <p className="text-[13px] font-medium text-amber-200">{issue.title}</p>
            <p className="mt-1 text-[12.5px] text-white/60">{issue.description}</p>
            <div className="mt-3 flex gap-2">
              {issue.onRepair && (
                <Button size="sm" onClick={issue.onRepair} className="h-8 gap-1.5 text-xs">
                  <Wrench className="h-3.5 w-3.5" /> Repair
                </Button>
              )}
              {issue.onRetry && (
                <Button size="sm" variant="outline" onClick={issue.onRetry} className="h-8 gap-1.5 text-xs">
                  <RotateCcw className="h-3.5 w-3.5" /> Retry
                </Button>
              )}
            </div>
          </div>
        )}

        {/* How it ships */}
        <div className="grid gap-2 sm:grid-cols-2">
          <Fact icon={<ListChecks className="h-4 w-4" />} title="Built from your words">Each request becomes a revision, checked against a real build.</Fact>
          <Fact icon={<Database className="h-4 w-4" />} title="Your own database">Tables, logins and server logic live with this app.</Fact>
          <Fact icon={<History className="h-4 w-4" />} title="Roll back any change">Every revision is kept. Undo from the message that made it.</Fact>
          <Fact icon={<Rocket className="h-4 w-4" />} title="Ship when ready">Publish to your own address, with SEO and a custom domain.</Fact>
        </div>

        {/* Tip */}
        <p key={tip} className="animate-msg-appear text-[12.5px] text-white/45">
          <span className="text-white/60">Tip</span> · {TIPS[tip]}
        </p>
      </div>
    </div>
  );
}

function Fact({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-white/[0.07] px-3.5 py-3">
      <span className="mt-0.5 shrink-0 text-white/60">{icon}</span>
      <div>
        <p className="text-[12.5px] font-medium text-white/85">{title}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-white/45">{children}</p>
      </div>
    </div>
  );
}

export default PreviewPlaceholder;
