import { useEffect, useMemo, useRef } from "react";

// Deterministic PRNG so the dot cloud is stable across renders (no client/server mismatch).
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pt = [number, number];

// Rough continent silhouettes as sampled points on a 1000x500 equirectangular-ish canvas.
const REGIONS: Array<[number, number, number, number, number]> = [
  [200, 150, 90, 70, 55], // North America
  [260, 320, 45, 90, 40], // South America
  [500, 120, 45, 40, 35], // Europe
  [500, 260, 55, 90, 45], // Africa
  [650, 140, 120, 80, 70], // Asia
  [800, 340, 45, 35, 22], // Australia
  [720, 260, 40, 30, 18], // SE Asia islands
];

function buildDots(): Pt[] {
  const rand = mulberry32(7);
  const pts: Pt[] = [];
  for (const [cx, cy, rx, ry, n] of REGIONS) {
    let made = 0;
    let tries = 0;
    while (made < n && tries < n * 12) {
      tries++;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand());
      const x = cx + Math.cos(a) * rx * r;
      const y = cy + Math.sin(a) * ry * r * 0.85;
      pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
      made++;
    }
  }
  return pts;
}

function closestTo(pts: Pt[], target: [number, number], exclude: Pt[] = []) {
  let best = pts[0];
  let bestD = Infinity;
  for (const p of pts) {
    if (exclude.some((e) => e[0] === p[0] && e[1] === p[1])) continue;
    const d = (p[0] - target[0]) ** 2 + (p[1] - target[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function arcPath(p0: Pt, p1: Pt, bow = 0.28) {
  const [x0, y0] = p0;
  const [x1, y1] = p1;
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

const LOOP = 10;
const ARC_TRAVEL = 1.3;
const PROMPT_TEXT = "eComGear, build my storefront.";

function ease(t: number) {
  return 1 - Math.pow(1 - t, 3);
}
function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

export function GlobalReach() {
  const rootRef = useRef<HTMLDivElement>(null);

  const { dots, origin, targets, arcs, mesh } = useMemo(() => {
    const dots = buildDots();
    const origin = closestTo(dots, [190, 140]);
    const targetSeeds: Array<[number, number]> = [
      [500, 120],
      [500, 260],
      [650, 140],
      [800, 340],
      [260, 320],
      [700, 250],
    ];
    const targets: Pt[] = [];
    for (const seed of targetSeeds) {
      const t = closestTo(dots, seed, [origin, ...targets]);
      targets.push(t);
    }
    const arcs = targets.map((t, i) => ({
      id: `reach-arc-${i}`,
      d: arcPath(origin, t),
      start: 0.9 + i * 0.42,
      target: t,
    }));
    const mesh = targets.map((_, i) => {
      const j = (i + 1) % targets.length;
      return {
        id: `reach-mesh-${i}`,
        d: arcPath(targets[i], targets[j], 0.14),
        start: 5.6 + i * 0.18,
      };
    });
    return { dots, origin, targets, arcs, mesh };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const promptEl = root.querySelector<HTMLElement>("[data-reach-prompt]");
    const caretEl = root.querySelector<HTMLElement>("[data-reach-caret]");
    const line0 = root.querySelector<HTMLElement>("[data-reach-line0]");
    const line1 = root.querySelector<HTMLElement>("[data-reach-line1]");
    const line2 = root.querySelector<HTMLElement>("[data-reach-line2]");
    const originDot = root.querySelector<SVGCircleElement>("[data-reach-origin]");
    const pulseRing = root.querySelector<SVGCircleElement>("[data-reach-pulse]");
    const pulseRing2 = root.querySelector<SVGCircleElement>("[data-reach-pulse2]");

    const arcEls = arcs.map((a) => {
      const path = root.querySelector<SVGPathElement>(`#${a.id}`)!;
      const comet = root.querySelector<SVGCircleElement>(`#${a.id}-comet`)!;
      const ring = root.querySelector<SVGCircleElement>(`#${a.id}-ring`)!;
      const targetDot = root.querySelector<SVGCircleElement>(`#${a.id}-target`)!;
      const len = path.getTotalLength();
      path.style.strokeDasharray = `${len}`;
      path.style.strokeDashoffset = `${len}`;
      return { ...a, path, comet, ring, targetDot, len };
    });

    const meshEls = mesh.map((m) => {
      const path = root.querySelector<SVGPathElement>(`#${m.id}`)!;
      const len = path.getTotalLength();
      path.style.strokeDasharray = `${len}`;
      path.style.strokeDashoffset = `${len}`;
      return { ...m, path, len };
    });

    let raf = 0;
    let playing = true;
    const t0 = performance.now();

    const io = new IntersectionObserver(
      ([entry]) => {
        playing = entry.isIntersecting;
      },
      { threshold: 0.15 },
    );
    io.observe(root);

    function render(now: number) {
      raf = requestAnimationFrame(render);
      if (!playing) return;
      const elapsed = ((now - t0) / 1000) % LOOP;

      // Beat 1: typed prompt
      const typeStart = 0.2;
      const typeEnd = 1.9;
      let chars = 0;
      if (elapsed >= typeStart) {
        chars = Math.round(clamp01((elapsed - typeStart) / (typeEnd - typeStart)) * PROMPT_TEXT.length);
      }
      const showPrompt = elapsed < 2.4;
      if (line0) line0.style.opacity = showPrompt ? "1" : "0";
      if (promptEl) promptEl.textContent = PROMPT_TEXT.slice(0, chars);
      if (caretEl) caretEl.style.opacity = showPrompt ? "1" : "0";

      // Beat 2: launch pulse
      const pulseStart = 2.0;
      const pulseP = clamp01((elapsed - pulseStart) / 1.0);
      pulseRing?.setAttribute("r", `${3 + pulseP * 40}`);
      pulseRing?.setAttribute("opacity", `${(1 - pulseP) * 0.9}`);
      const pulseP2 = clamp01((elapsed - pulseStart - 0.25) / 1.0);
      pulseRing2?.setAttribute("r", `${3 + pulseP2 * 55}`);
      pulseRing2?.setAttribute("opacity", `${(1 - pulseP2) * 0.5}`);
      originDot?.setAttribute("r", `${3.2 + Math.sin(elapsed * 6) * 0.6}`);

      if (line1) {
        line1.style.opacity = `${clamp01(clamp01((elapsed - 2.3) / 0.5) - clamp01((elapsed - 4.6) / 0.5))}`;
      }

      // Beat 3: comets travel, target dots + arrival rings
      for (const a of arcEls) {
        const localP = clamp01((elapsed - a.start) / ARC_TRAVEL);
        const e = ease(localP);
        const traveling = elapsed >= a.start && localP < 1;

        a.path.style.opacity = traveling ? "0.55" : localP >= 1 ? "0.28" : "0";
        a.path.style.strokeDashoffset = `${a.len * (1 - e)}`;

        if (traveling) {
          const pt = a.path.getPointAtLength(a.len * localP);
          a.comet.setAttribute("cx", `${pt.x}`);
          a.comet.setAttribute("cy", `${pt.y}`);
          a.comet.style.opacity = "1";
        } else {
          a.comet.style.opacity = "0";
        }

        const dotP = clamp01((elapsed - (a.start + ARC_TRAVEL)) / 0.35);
        a.targetDot.style.opacity = `${dotP}`;
        a.targetDot.setAttribute("fill", dotP > 0 ? "#22c55e" : "rgba(246,245,241,0.16)");

        const ringP = clamp01((elapsed - (a.start + ARC_TRAVEL)) / 0.7);
        a.ring.setAttribute("r", `${3 + ringP * 16}`);
        a.ring.setAttribute("opacity", `${(1 - ringP) * (ringP > 0 ? 0.8 : 0)}`);
      }

      // Beat 4: mesh knits the reached markets together
      for (const m of meshEls) {
        const p = clamp01((elapsed - m.start) / 0.9);
        const e = ease(p);
        m.path.style.strokeDashoffset = `${m.len * (1 - e)}`;
        m.path.style.opacity = p > 0 ? `${0.35 * p}` : "0";
      }

      if (line2) {
        line2.style.opacity = `${clamp01(clamp01((elapsed - 4.9) / 0.5) - clamp01((elapsed - 9.4) / 0.5))}`;
      }
    }

    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="reach" id="reach" ref={rootRef}>
      <div className="section-head">
        <div className="section-head__num">01</div>
        <div className="section-head__label">GLOBAL REACH</div>
        <div className="section-head__spacer" />
      </div>
      <div className="reach__headline">
        <h2 className="section-title">
          One prompt. <span className="section-title__accent">Live to the world.</span>
        </h2>
        <p className="section-sub">
          Describe your storefront and the agent ships it, then starts routing traffic and
          orders across markets in minutes, no ops team, no manual rollout.
        </p>
      </div>

      <div className="reach__stage">
        <svg className="reach__map" viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid meet">
          {dots.map(([x, y], i) => (
            <circle
              key={i}
              className="reach__dot"
              cx={x}
              cy={y}
              r={1.6}
              style={{ animationDelay: `${((x + y) % 37) / 10}s` }}
            />
          ))}

          {mesh.map((m) => (
            <path key={m.id} id={m.id} className="reach__mesh" d={m.d} fill="none" />
          ))}

          {arcs.map((a) => (
            <path key={a.id} id={a.id} className="reach__arc" d={a.d} fill="none" />
          ))}

          {arcs.map((a) => (
            <circle
              key={`${a.id}-target`}
              id={`${a.id}-target`}
              className="reach__dot reach__dot--target"
              cx={a.target[0]}
              cy={a.target[1]}
              r={2.6}
            />
          ))}

          {arcs.map((a) => (
            <circle
              key={`${a.id}-ring`}
              id={`${a.id}-ring`}
              cx={a.target[0]}
              cy={a.target[1]}
              r={3}
              className="reach__arrive-ring"
              fill="none"
              opacity={0}
            />
          ))}

          {arcs.map((a) => (
            <circle key={`${a.id}-comet`} id={`${a.id}-comet`} className="reach__comet" r={3.2} opacity={0} />
          ))}

          <circle data-reach-origin cx={origin[0]} cy={origin[1]} r={3.2} className="reach__dot reach__dot--origin" />
          <circle
            data-reach-pulse
            cx={origin[0]}
            cy={origin[1]}
            r={3}
            fill="none"
            className="reach__pulse-ring"
            opacity={0}
          />
          <circle
            data-reach-pulse2
            cx={origin[0]}
            cy={origin[1]}
            r={3}
            fill="none"
            className="reach__pulse-ring reach__pulse-ring--soft"
            opacity={0}
          />
        </svg>

        <div className="reach__center-text">
          <div className="reach__line reach__line--prompt" data-reach-line0>
            <span data-reach-prompt />
            <span className="reach__caret" data-reach-caret />
          </div>
          <div className="reach__line" data-reach-line1>
            Live in <span className="reach__accent">under a minute.</span>
          </div>
          <div className="reach__line" data-reach-line2>
            Already <span className="reach__accent">selling worldwide.</span>
          </div>
        </div>
      </div>
    </section>
  );
}
