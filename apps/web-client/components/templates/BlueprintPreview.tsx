/**
 * Wireframe thumbnails for the starter blueprints: one small SVG per
 * blueprint id, drawn in white on the card's gradient so it reads as a UI
 * preview without shipping images. 320 x 180 viewBox, scales with the card.
 */
import type { ReactNode } from 'react';

const W = 320;
const H = 180;

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
      <rect x={16} y={14} width={W - 32} height={H - 14} rx={8} fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.35)" />
      {children}
    </svg>
  );
}

const ink = 'rgba(255,255,255,0.85)';
const soft = 'rgba(255,255,255,0.28)';
const faint = 'rgba(255,255,255,0.14)';

function Sidebar({ x = 16, y = 14, w = 54, h = H - 14 }: { x?: number; y?: number; w?: number; h?: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={faint} />
      <rect x={x + 10} y={y + 12} width={w - 20} height={8} rx={2} fill={ink} />
      {[0, 1, 2, 3, 4].map((i) => <rect key={i} x={x + 10} y={y + 32 + i * 14} width={w - 24} height={5} rx={2} fill={i === 1 ? ink : soft} />)}
    </g>
  );
}

function Topbar({ x = 78, y = 22, w = W - 94 }: { x?: number; y?: number; w?: number }) {
  return (
    <g>
      <rect x={x} y={y} width={90} height={9} rx={4} fill={soft} />
      <rect x={x + w - 24} y={y} width={24} height={9} rx={4.5} fill={ink} />
    </g>
  );
}

function Table({ x, y, w, rows = 4, cols = 4 }: { x: number; y: number; w: number; rows?: number; cols?: number }) {
  const colW = (w - 8) / cols;
  return (
    <g>
      <rect x={x} y={y} width={w} height={12} rx={3} fill={soft} />
      {Array.from({ length: rows }).map((_, r) => (
        <g key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <rect key={c} x={x + 4 + c * colW} y={y + 18 + r * 14} width={colW * (c === 0 ? 0.8 : 0.55)} height={5} rx={2} fill={c === cols - 1 ? ink : soft} />
          ))}
        </g>
      ))}
    </g>
  );
}

function Kpi({ x, y, w = 52 }: { x: number; y: number; w?: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={34} rx={5} fill={faint} stroke={soft} />
      <rect x={x + 6} y={y + 6} width={w * 0.5} height={4} rx={2} fill={soft} />
      <rect x={x + 6} y={y + 15} width={w * 0.35} height={8} rx={2} fill={ink} />
      <polyline points={`${x + w - 26},${y + 26} ${x + w - 20},${y + 20} ${x + w - 14},${y + 24} ${x + w - 8},${y + 14}`} fill="none" stroke={ink} strokeWidth={1.5} />
    </g>
  );
}

function Chart({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const pts = [0.6, 0.45, 0.55, 0.3, 0.4, 0.2, 0.28, 0.1].map((v, i, a) => `${x + 6 + (i / (a.length - 1)) * (w - 12)},${y + 6 + v * (h - 12)}`).join(' ');
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={5} fill={faint} stroke={soft} />
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={x + 6} x2={x + w - 6} y1={y + f * h} y2={y + f * h} stroke={faint} />)}
      <polyline points={pts} fill="none" stroke={ink} strokeWidth={2} strokeLinejoin="round" />
    </g>
  );
}

function AdminDashboard() {
  return (
    <Frame>
      <Sidebar />
      <Topbar />
      {[0, 1, 2, 3].map((i) => <Kpi key={i} x={78 + i * 56} y={38} />)}
      <Chart x={78} y={80} w={130} h={80} />
      <Table x={216} y={80} w={86} rows={4} cols={2} />
    </Frame>
  );
}

function ErpSuite() {
  const tiles = ['Sales', 'Purchasing', 'Inventory', 'Accounting', 'HR', 'Projects'];
  return (
    <Frame>
      <Sidebar />
      <Topbar />
      {tiles.map((_, i) => {
        const x = 78 + (i % 3) * 76; const y = 40 + Math.floor(i / 3) * 58;
        return (
          <g key={i}>
            <rect x={x} y={y} width={68} height={48} rx={6} fill={faint} stroke={soft} />
            <rect x={x + 8} y={y + 8} width={14} height={14} rx={3} fill={ink} />
            <rect x={x + 8} y={y + 28} width={36} height={5} rx={2} fill={soft} />
            <rect x={x + 8} y={y + 37} width={20} height={4} rx={2} fill={soft} />
            <rect x={x + 46} y={y + 8} width={14} height={8} rx={4} fill={ink} />
          </g>
        );
      })}
      <rect x={78} y={158} width={224} height={8} rx={3} fill={soft} />
    </Frame>
  );
}

function Crm() {
  const cols = [3, 2, 3, 1, 2];
  return (
    <Frame>
      <Sidebar w={44} />
      <Topbar x={68} w={W - 84} />
      {cols.map((n, c) => {
        const x = 68 + c * 48;
        return (
          <g key={c}>
            <rect x={x} y={40} width={42} height={7} rx={3} fill={ink} opacity={0.6} />
            {Array.from({ length: n }).map((_, r) => (
              <g key={r}>
                <rect x={x} y={54 + r * 34} width={42} height={28} rx={5} fill={faint} stroke={soft} />
                <rect x={x + 5} y={54 + r * 34 + 6} width={26} height={4} rx={2} fill={ink} />
                <rect x={x + 5} y={54 + r * 34 + 14} width={18} height={4} rx={2} fill={soft} />
                <circle cx={x + 34} cy={54 + r * 34 + 21} r={4} fill={ink} />
              </g>
            ))}
          </g>
        );
      })}
    </Frame>
  );
}

function SaasLanding() {
  return (
    <Frame>
      <rect x={28} y={24} width={40} height={7} rx={3} fill={ink} />
      {[0, 1, 2].map((i) => <rect key={i} x={200 + i * 30} y={25} width={20} height={5} rx={2} fill={soft} />)}
      <rect x={272} y={22} width={30} height={11} rx={5.5} fill={ink} />
      <rect x={28} y={50} width={130} height={12} rx={4} fill={ink} />
      <rect x={28} y={66} width={104} height={12} rx={4} fill={ink} />
      <rect x={28} y={86} width={118} height={5} rx={2} fill={soft} />
      <rect x={28} y={94} width={90} height={5} rx={2} fill={soft} />
      <rect x={28} y={108} width={40} height={13} rx={6.5} fill={ink} />
      <rect x={74} y={108} width={40} height={13} rx={6.5} fill="none" stroke={ink} />
      <rect x={176} y={48} width={126} height={78} rx={6} fill={faint} stroke={soft} />
      <rect x={186} y={58} width={106} height={8} rx={3} fill={soft} />
      <rect x={186} y={72} width={50} height={44} rx={4} fill={soft} />
      <rect x={242} y={72} width={50} height={20} rx={4} fill={soft} />
      <rect x={242} y={96} width={50} height={20} rx={4} fill={soft} />
      {[0, 1, 2, 3, 4, 5].map((i) => <rect key={i} x={28 + i * 46} y={140} width={30} height={8} rx={3} fill={soft} />)}
      <rect x={28} y={158} width={274} height={10} rx={3} fill={faint} />
    </Frame>
  );
}

function CreativeAgency() {
  return (
    <Frame>
      <rect x={28} y={26} width={190} height={22} rx={4} fill={ink} />
      <rect x={28} y={52} width={140} height={22} rx={4} fill={ink} />
      <rect x={28} y={82} width={110} height={5} rx={2} fill={soft} />
      <rect x={28} y={98} width={128} height={64} rx={5} fill={soft} />
      <rect x={164} y={86} width={138} height={44} rx={5} fill={soft} />
      <rect x={164} y={136} width={64} height={26} rx={5} fill={soft} />
      <rect x={236} y={136} width={66} height={26} rx={5} fill={ink} opacity={0.5} />
      <rect x={232} y={26} width={70} height={7} rx={3} fill={soft} />
      <rect x={232} y={38} width={50} height={7} rx={3} fill={soft} />
    </Frame>
  );
}

function ThreeD() {
  return (
    <Frame>
      <defs>
        <radialGradient id="bp-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.45)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>
      <circle cx={214} cy={92} r={64} fill="url(#bp-glow)" />
      <g transform="translate(214 92)">
        <polygon points="0,-38 34,-19 34,19 0,38 -34,19 -34,-19" fill={faint} stroke={ink} strokeWidth={1.5} />
        <polygon points="0,-38 34,-19 0,0 -34,-19" fill="rgba(255,255,255,0.35)" />
        <polygon points="0,0 34,-19 34,19 0,38" fill="rgba(255,255,255,0.18)" />
        <line x1={0} y1={0} x2={0} y2={38} stroke={ink} strokeWidth={1.2} />
        <line x1={0} y1={0} x2={-34} y2={-19} stroke={ink} strokeWidth={1.2} />
        <line x1={0} y1={0} x2={34} y2={-19} stroke={ink} strokeWidth={1.2} />
      </g>
      <ellipse cx={214} cy={142} rx={40} ry={6} fill="rgba(0,0,0,0.25)" />
      <rect x={28} y={40} width={110} height={70} rx={8} fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.4)" />
      <rect x={38} y={52} width={80} height={9} rx={3} fill={ink} />
      <rect x={38} y={67} width={66} height={5} rx={2} fill={soft} />
      <rect x={38} y={76} width={54} height={5} rx={2} fill={soft} />
      <rect x={38} y={90} width={36} height={11} rx={5.5} fill={ink} />
      {[0, 1, 2, 3].map((i) => <circle key={i} cx={296} cy={60 + i * 20} r={i === 1 ? 4 : 2.5} fill={i === 1 ? ink : soft} />)}
    </Frame>
  );
}

function MathBook() {
  return (
    <Frame>
      <Sidebar w={58} />
      <rect x={90} y={26} width={120} height={9} rx={3} fill={ink} />
      <rect x={90} y={42} width={196} height={4} rx={2} fill={soft} />
      <rect x={90} y={50} width={180} height={4} rx={2} fill={soft} />
      <rect x={90} y={58} width={190} height={4} rx={2} fill={soft} />
      <rect x={90} y={70} width={196} height={30} rx={4} fill={faint} stroke={ink} strokeWidth={0.8} />
      <rect x={90} y={70} width={3} height={30} fill={ink} />
      <rect x={100} y={77} width={56} height={5} rx={2} fill={ink} />
      <rect x={100} y={87} width={150} height={4} rx={2} fill={soft} />
      <text x={130} y={122} fill={ink} fontSize={14} fontFamily="serif" fontStyle="italic">∑ xᵢ² = ∫ f(x) dx</text>
      <rect x={264} y={112} width={22} height={7} rx={2} fill={soft} />
      <rect x={90} y={134} width={196} height={4} rx={2} fill={soft} />
      <rect x={90} y={142} width={160} height={4} rx={2} fill={soft} />
      <rect x={90} y={154} width={60} height={9} rx={4.5} fill="none" stroke={ink} />
    </Frame>
  );
}

function Learning() {
  return (
    <Frame>
      <Topbar x={28} y={24} w={W - 56} />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={28 + i * 94} y={44} width={84} height={64} rx={6} fill={faint} stroke={soft} />
          <rect x={28 + i * 94} y={44} width={84} height={30} rx={6} fill={soft} />
          <rect x={36 + i * 94} y={82} width={50} height={5} rx={2} fill={ink} />
          <rect x={36 + i * 94} y={92} width={68} height={4} rx={2} fill={faint} />
          <rect x={36 + i * 94} y={92} width={[46, 20, 60][i]} height={4} rx={2} fill={ink} />
        </g>
      ))}
      <rect x={28} y={120} width={172} height={46} rx={6} fill={soft} />
      <polygon points="104,134 104,152 120,143" fill={ink} />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <circle cx={216} cy={128 + i * 15} r={4} fill={i < 2 ? ink : 'none'} stroke={ink} />
          <rect x={226} y={125 + i * 15} width={70} height={5} rx={2} fill={i < 2 ? soft : ink} />
        </g>
      ))}
    </Frame>
  );
}

function Research() {
  return (
    <Frame>
      <Table x={28} y={26} w={150} rows={6} cols={3} />
      <rect x={190} y={26} width={112} height={60} rx={6} fill={faint} stroke={soft} />
      <rect x={198} y={34} width={70} height={6} rx={2} fill={ink} />
      <rect x={198} y={46} width={96} height={4} rx={2} fill={soft} />
      <rect x={198} y={54} width={88} height={4} rx={2} fill={soft} />
      <rect x={198} y={66} width={40} height={4} rx={2} fill="rgba(255,220,120,0.9)" />
      <rect x={198} y={74} width={60} height={4} rx={2} fill={soft} />
      {[[210, 120], [250, 104], [286, 130], [236, 150], [274, 158]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i === 1 ? 6 : 4} fill={i === 1 ? ink : soft} />)}
      {[[210, 120, 250, 104], [250, 104, 286, 130], [250, 104, 236, 150], [236, 150, 274, 158], [286, 130, 274, 158]].map(([x1, y1, x2, y2], i) => <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={soft} strokeWidth={1.2} />)}
    </Frame>
  );
}

function Storefront() {
  return (
    <Frame>
      <Topbar x={28} y={24} w={W - 56} />
      <rect x={28} y={40} width={40} height={124} rx={5} fill={faint} />
      {[0, 1, 2, 3].map((i) => <rect key={i} x={34} y={50 + i * 14} width={24} height={5} rx={2} fill={i === 0 ? ink : soft} />)}
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const x = 76 + (i % 3) * 76; const y = 40 + Math.floor(i / 3) * 64;
        return (
          <g key={i}>
            <rect x={x} y={y} width={68} height={40} rx={5} fill={soft} />
            <rect x={x} y={y + 44} width={40} height={5} rx={2} fill={ink} />
            <rect x={x} y={y + 52} width={22} height={5} rx={2} fill={soft} />
            <rect x={x + 46} y={y + 50} width={22} height={9} rx={4.5} fill={ink} />
          </g>
        );
      })}
    </Frame>
  );
}

function Booking() {
  return (
    <Frame>
      <rect x={28} y={26} width={120} height={8} rx={3} fill={ink} />
      {Array.from({ length: 28 }).map((_, i) => {
        const x = 28 + (i % 7) * 18; const y = 44 + Math.floor(i / 7) * 18;
        const on = [3, 4, 9, 10, 11, 16, 17, 23].includes(i);
        return <rect key={i} x={x} y={y} width={14} height={14} rx={3} fill={on ? ink : faint} opacity={on ? (i === 10 ? 1 : 0.6) : 1} />;
      })}
      <rect x={170} y={26} width={60} height={7} rx={3} fill={soft} />
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const x = 170 + (i % 2) * 66; const y = 42 + Math.floor(i / 2) * 22;
        return <rect key={i} x={x} y={y} width={60} height={16} rx={8} fill={i === 2 ? ink : 'none'} stroke={ink} strokeWidth={1} />;
      })}
      <rect x={170} y={116} width={132} height={48} rx={6} fill={faint} stroke={soft} />
      <rect x={178} y={124} width={70} height={5} rx={2} fill={ink} />
      <rect x={178} y={134} width={100} height={4} rx={2} fill={soft} />
      <rect x={178} y={148} width={48} height={10} rx={5} fill={ink} />
    </Frame>
  );
}

function Portfolio() {
  return (
    <Frame>
      <rect x={60} y={30} width={90} height={9} rx={3} fill={ink} />
      <rect x={60} y={44} width={60} height={5} rx={2} fill={soft} />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <line x1={60} x2={260} y1={66 + i * 24} y2={66 + i * 24} stroke={faint} />
          <rect x={60} y={72 + i * 24} width={[80, 60, 96, 70][i]} height={6} rx={2} fill={ink} />
          <rect x={200} y={72 + i * 24} width={24} height={5} rx={2} fill={soft} />
          <rect x={244} y={71 + i * 24} width={16} height={8} rx={2} fill={i === 1 ? soft : 'none'} />
        </g>
      ))}
    </Frame>
  );
}

function Docs() {
  return (
    <Frame>
      <Sidebar w={62} />
      <rect x={90} y={26} width={110} height={9} rx={3} fill={ink} />
      <rect x={90} y={42} width={150} height={4} rx={2} fill={soft} />
      <rect x={90} y={50} width={140} height={4} rx={2} fill={soft} />
      <rect x={90} y={62} width={150} height={40} rx={4} fill="rgba(0,0,0,0.35)" />
      {[0, 1, 2].map((i) => <rect key={i} x={98} y={70 + i * 9} width={[60, 90, 40][i]} height={4} rx={2} fill={ink} opacity={0.8} />)}
      <rect x={90} y={112} width={150} height={4} rx={2} fill={soft} />
      <rect x={90} y={120} width={120} height={4} rx={2} fill={soft} />
      <rect x={90} y={132} width={150} height={22} rx={4} fill={faint} stroke={ink} strokeWidth={0.8} />
      <rect x={90} y={132} width={3} height={22} fill={ink} />
      {[0, 1, 2, 3].map((i) => <rect key={i} x={252} y={30 + i * 12} width={[44, 36, 40, 30][i]} height={4} rx={2} fill={i === 0 ? ink : soft} />)}
    </Frame>
  );
}

const PREVIEWS: Record<string, () => ReactNode> = {
  'admin-dashboard': AdminDashboard,
  'erp-suite': ErpSuite,
  crm: Crm,
  'saas-landing': SaasLanding,
  'creative-agency': CreativeAgency,
  'three-d-showcase': ThreeD,
  'math-textbook': MathBook,
  'learning-platform': Learning,
  'research-hub': Research,
  storefront: Storefront,
  booking: Booking,
  portfolio: Portfolio,
  'docs-site': Docs,
};

export function BlueprintPreview({ id }: { id: string }) {
  const Preview = PREVIEWS[id] ?? AdminDashboard;
  return <Preview />;
}
