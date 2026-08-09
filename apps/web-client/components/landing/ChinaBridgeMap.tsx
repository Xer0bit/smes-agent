import { useEffect, useRef } from "react";

type Node = { id: string; name: string; role: string; x: number; y: number };

// Radial layout, not literal cartography — hub + 4 bridge markets, capped at 5 nodes
// per the Map/Diagram macrostructure's node limit.
const HUB: Node = { id: "cn", name: "Mainland China", role: "ICP Licensed", x: 400, y: 250 };
const NODES: Node[] = [
  { id: "hk", name: "Hong Kong", role: "Gateway Hub", x: 528, y: 336 },
  { id: "sg", name: "Singapore", role: "SEA Node", x: 420, y: 402 },
  { id: "us", name: "United States", role: "Americas", x: 686, y: 176 },
  { id: "eu", name: "Europe", role: "GDPR Zone", x: 132, y: 190 },
];

function arcPath(x0: number, y0: number, x1: number, y1: number, bow = 0.22) {
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist;
  const ny = dx / dist;
  const cx = mx + nx * dist * bow;
  const cy = my + ny * dist * bow;
  return `M ${x0} ${y0} Q ${cx} ${cy} ${x1} ${y1}`;
}

export function ChinaBridgeMap() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const arcs = Array.from(root.querySelectorAll<SVGPathElement>("[data-bridge-arc]"));
    const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-bridge-node]"));
    const comets = Array.from(root.querySelectorAll<SVGCircleElement>("[data-bridge-comet]"));

    arcs.forEach((path) => {
      const len = path.getTotalLength();
      path.style.strokeDasharray = `${len}`;
      path.style.strokeDashoffset = `${len}`;
    });

    let played = false;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || played) return;
        played = true;

        nodes.forEach((el, i) => {
          window.setTimeout(() => el.classList.add("is-in"), 120 + i * 110);
        });

        arcs.forEach((path, i) => {
          const len = path.getTotalLength();
          const delay = 500 + i * 160;
          window.setTimeout(() => {
            path.style.transition = "stroke-dashoffset 0.9s cubic-bezier(0.16,1,0.3,1)";
            path.style.strokeDashoffset = "0";

            const comet = comets[i];
            if (!comet) return;
            comet.style.opacity = "1";
            const start = performance.now();
            const dur = 900;
            function step(now: number) {
              const p = Math.min(1, (now - start) / dur);
              const pt = path.getPointAtLength(len * p);
              comet.setAttribute("cx", `${pt.x}`);
              comet.setAttribute("cy", `${pt.y}`);
              if (p < 1) requestAnimationFrame(step);
              else comet.style.opacity = "0";
            }
            requestAnimationFrame(step);
          }, delay);
        });

        io.disconnect();
      },
      { threshold: 0.3 },
    );
    io.observe(root);
    return () => io.disconnect();
  }, []);

  return (
    <div className="china-map" ref={rootRef}>
      <svg className="china-map__svg" viewBox="0 0 800 480" preserveAspectRatio="xMidYMid meet">
        {NODES.map((n, i) => (
          <path
            key={n.id}
            data-bridge-arc
            className="china-map__arc"
            d={arcPath(HUB.x, HUB.y, n.x, n.y, i % 2 === 0 ? 0.22 : -0.22)}
            fill="none"
          />
        ))}
        {NODES.map((n, i) => (
          <circle key={`${n.id}-comet`} data-bridge-comet className="china-map__comet" r="4" opacity="0" />
        ))}
        <circle className="china-map__hub-glow" cx={HUB.x} cy={HUB.y} r="34" />
        <circle className="china-map__hub-dot" cx={HUB.x} cy={HUB.y} r="6" />
      </svg>

      <div className="china-map__hub-label" style={{ left: `${(HUB.x / 800) * 100}%`, top: `${(HUB.y / 480) * 100}%` }}>
        <span className="china-map__hub-name">{HUB.name}</span>
        <span className="china-map__hub-role">{HUB.role}</span>
      </div>

      {NODES.map((n) => (
        <div
          key={n.id}
          data-bridge-node
          className="china-map__node"
          style={{ left: `${(n.x / 800) * 100}%`, top: `${(n.y / 480) * 100}%` }}
          title={`${n.name} — ${n.role}`}
        >
          <span className="china-map__node-dot" />
          <span className="china-map__node-name">{n.name}</span>
          <span className="china-map__node-role">{n.role}</span>
        </div>
      ))}
    </div>
  );
}
