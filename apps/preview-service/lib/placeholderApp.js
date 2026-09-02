'use strict';

/**
 * The App.tsx a project shows before it has an app of its own.
 *
 * initProject() and materializeProjectFiles() both used to write a spinner
 * with "Initializing Preview..." (or "Preview Ready") here, which is what a
 * brand-new project's preview displayed for the whole first build. This is
 * a billboard instead: an app wireframe assembling itself on a loop, the
 * build pipeline with a moving progress line, a few facts about how apps
 * built here ship, and a rotating tip. Same flat dark style as the editor,
 * EcomGear mark linking to ecomgear.dev.
 *
 * Self-contained on purpose: React only, inline styles plus one <style> tag
 * for the keyframes, no Tailwind classes and no imports the scaffold might
 * not have. Every animation is opacity/transform only. The agent overwrites
 * this file on the first real build; the marker comment tells it (and any
 * tool that counts "user files") that nothing here is the owner's.
 */

const PLACEHOLDER_MARKER = 'ECOMGEAR_PLACEHOLDER_APP';

const PLACEHOLDER_APP_TSX = `// ${PLACEHOLDER_MARKER}: scaffold billboard, not the owner's app. Replace this whole file.
import { useEffect, useState, type CSSProperties } from 'react';

const STAGES = ['Plan', 'Build', 'Check', 'Preview', 'Publish'];

const TIPS = [
  'Ask for one feature at a time. Smaller requests land faster and cost less.',
  'Use Plan mode to talk a feature through before anything is built.',
  'Upload a spec, a screenshot or a brand file: its content becomes project knowledge.',
  'Every change is a revision you can roll back from the chat.',
  'Logins live in your own database, written as edge functions with hashed passwords.',
  'Publish puts the app on its own address; connect a custom domain from Settings.',
];

const FACTS: Array<[string, string, string]> = [
  ['M4 6h16M4 12h16M4 18h10', 'Built from your words', 'Each request becomes a revision, checked against a real build.'],
  ['M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7', 'Your own database', 'Tables, logins and server logic live with this app, not on a shared service.'],
  ['M3 12a9 9 0 1 0 3-6.7M3 4v5h5', 'Roll back any change', 'Every revision is kept. Undo from the message that made it.'],
  ['M5 12l5 5L20 7', 'Ship when ready', 'Publish to your own address, with SEO and a custom domain.'],
];

const CSS = \`
@keyframes eg-rise { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: translateY(0) } }
@keyframes eg-draw { from { transform: scaleX(0) } to { transform: scaleX(1) } }
@keyframes eg-pop  { 0% { opacity: 0; transform: scale(.94) } 60% { opacity: 1; transform: scale(1.02) } 100% { transform: scale(1) } }
@keyframes eg-sweep { 0% { transform: translateX(-100%) } 100% { transform: translateX(400%) } }
@keyframes eg-cursor { 0%,100% { transform: translate(0,0) } 30% { transform: translate(140px,54px) } 60% { transform: translate(60px,120px) } 85% { transform: translate(200px,90px) } }
@keyframes eg-pulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }
@keyframes eg-fade { 0% { opacity: 0; transform: translateY(4px) } 12% { opacity: 1; transform: none } 88% { opacity: 1 } 100% { opacity: 0 } }
.eg-scene > * { animation: eg-rise .6s cubic-bezier(.16,1,.3,1) both; }
.eg-bar { transform-origin: left; animation: eg-draw .7s cubic-bezier(.16,1,.3,1) both; }
.eg-card { animation: eg-pop .5s cubic-bezier(.16,1,.3,1) both; }
.eg-cursor { animation: eg-cursor 8s ease-in-out infinite; }
.eg-sweep { animation: eg-sweep 2.4s ease-in-out infinite; }
.eg-pulse { animation: eg-pulse 1.6s ease-in-out infinite; }
.eg-tip { animation: eg-fade 7s ease-in-out both; }
@media (prefers-reduced-motion: reduce) { .eg-scene > *, .eg-bar, .eg-card, .eg-cursor, .eg-sweep, .eg-pulse, .eg-tip { animation: none !important; opacity: 1 !important; transform: none !important; } }
\`;

const page: CSSProperties = {
  minHeight: '100vh', margin: 0, background: '#0c0c0e', color: '#fff',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  display: 'flex', justifyContent: 'center',
};
const wrap: CSSProperties = { width: '100%', maxWidth: 720, padding: '40px 28px', display: 'flex', flexDirection: 'column', gap: 28 };
const muted = 'rgba(255,255,255,0.45)';
const line = 'rgba(255,255,255,0.08)';

/** A browser window in which a page wireframe assembles itself, then again. */
function Scene({ cycle }: { cycle: number }) {
  const block = (w: string, h: number, delay: number, extra: CSSProperties = {}): CSSProperties => ({
    width: w, height: h, borderRadius: 6, background: 'rgba(255,255,255,0.12)', animationDelay: delay + 's', ...extra,
  });
  return (
    <div key={cycle} style={{ position: 'relative', border: '1px solid ' + line, borderRadius: 14, background: '#111114', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 6, padding: '10px 12px', borderBottom: '1px solid ' + line }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <span key={c} style={{ width: 9, height: 9, borderRadius: 5, background: c, opacity: .8 }} />)}
        <span style={{ marginLeft: 10, flex: 1, height: 9, borderRadius: 5, background: 'rgba(255,255,255,0.06)' }} />
      </div>
      <div className="eg-scene" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, animationDelay: '.1s' }}>
          <span style={block('22px', 22, .1, { borderRadius: 7, background: 'rgba(255,255,255,0.9)' })} />
          <span className="eg-bar" style={block('70px', 8, .25)} />
          <span style={{ flex: 1 }} />
          <span className="eg-bar" style={block('40px', 8, .35)} />
          <span className="eg-bar" style={block('40px', 8, .45)} />
          <span className="eg-card" style={block('64px', 22, .6, { background: 'rgba(255,255,255,0.9)', borderRadius: 11 })} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, animationDelay: '.7s' }}>
          <span className="eg-bar" style={block('62%', 16, .8, { background: 'rgba(255,255,255,0.6)' })} />
          <span className="eg-bar" style={block('44%', 16, 1.0, { background: 'rgba(255,255,255,0.6)' })} />
          <span className="eg-bar" style={block('55%', 8, 1.25)} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 6, animationDelay: '1.5s' }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="eg-card" style={{ animationDelay: (1.6 + i * .18) + 's', borderRadius: 10, border: '1px solid ' + line, padding: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
              <span style={block('100%', 46, 0, { background: 'rgba(255,255,255,0.08)' })} />
              <span style={block('70%', 7, 0)} />
              <span style={block('45%', 7, 0)} />
            </div>
          ))}
        </div>
      </div>
      <svg className="eg-cursor" width="16" height="18" viewBox="0 0 16 18" style={{ position: 'absolute', left: 60, top: 70, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.6))' }}>
        <path d="M1 1l5.5 15 2.3-6.2L15 7.5z" fill="#fff" stroke="#0c0c0e" strokeWidth="1" />
      </svg>
    </div>
  );
}

function App() {
  const [tip, setTip] = useState(0);
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    const a = setInterval(() => setTip((t) => (t + 1) % TIPS.length), 7000);
    const b = setInterval(() => setCycle((c) => c + 1), 9000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);

  return (
    <div style={page}>
      <style>{CSS}</style>
      <div style={wrap}>
        <div>
          <p style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: -0.2 }}>Your app is being built</p>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: muted }}>It appears right here the moment the first version can run.</p>
        </div>

        <Scene cycle={cycle} />

        <div>
          <ol style={{ display: 'flex', alignItems: 'center', gap: 8, listStyle: 'none', margin: 0, padding: 0, flexWrap: 'wrap' }}>
            {STAGES.map((name, i) => (
              <li key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: i === 1 ? 'rgba(255,255,255,0.9)' : i < 1 ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.3)' }}>
                  <span className={i === 1 ? 'eg-pulse' : undefined} style={{ width: 16, height: 16, borderRadius: 8, border: '1px solid ' + (i <= 1 ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.15)'), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9 }}>{i + 1}</span>
                  {name}
                </span>
                {i < STAGES.length - 1 && <span style={{ width: 16, height: 1, background: 'rgba(255,255,255,0.1)' }} />}
              </li>
            ))}
          </ol>
          <div style={{ position: 'relative', height: 2, marginTop: 12, borderRadius: 1, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div className="eg-sweep" style={{ position: 'absolute', top: 0, bottom: 0, width: '25%', borderRadius: 1, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.7), transparent)' }} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
          {FACTS.map(([d, title, body]) => (
            <div key={title} style={{ border: '1px solid ' + line, borderRadius: 12, padding: '12px 14px', display: 'flex', gap: 10 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d={d} /></svg>
              <div>
                <p style={{ margin: 0, fontSize: 12.5, fontWeight: 500, color: 'rgba(255,255,255,0.85)' }}>{title}</p>
                <p style={{ margin: '3px 0 0', fontSize: 12, lineHeight: 1.55, color: muted }}>{body}</p>
              </div>
            </div>
          ))}
        </div>

        <p key={tip} className="eg-tip" style={{ margin: 0, fontSize: 12.5, color: muted }}>
          <span style={{ color: 'rgba(255,255,255,0.65)' }}>Tip</span> · {TIPS[tip]}
        </p>

        <p style={{ margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
          Built with <a href="https://ecomgear.dev" target="_blank" rel="noreferrer" style={{ color: 'rgba(255,255,255,0.5)' }}>ecomgear.dev</a>
        </p>
      </div>
    </div>
  );
}

export default App;
`;

/** True when App.tsx is still the scaffold billboard, not something the owner or the agent built. */
function isPlaceholderApp(content) {
    return typeof content === 'string' && content.includes(PLACEHOLDER_MARKER);
}

module.exports = { PLACEHOLDER_APP_TSX, PLACEHOLDER_MARKER, isPlaceholderApp };
