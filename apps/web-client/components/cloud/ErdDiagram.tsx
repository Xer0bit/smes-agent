/**
 * Entity-relationship diagram drawn as plain SVG: one box per table with its
 * columns, one edge per foreign key. Layout is a simple layered grid that
 * puts referenced tables to the left of the tables that point at them, which
 * is enough for the handful of tables an app has. Pan by scrolling, zoom with
 * the buttons.
 */
import { useMemo, useState } from 'react';
import { KeyRound, Link2, Minus, Plus } from 'lucide-react';

export interface ErdColumn { name: string; type: string; nullable: boolean; primary_key: boolean; unique: boolean }
export interface ErdTable { name: string; columns: ErdColumn[] }
export interface ErdEdge { table: string; column: string; refTable: string; refColumn: string }

const BOX_W = 220;
const ROW_H = 22;
const HEAD_H = 32;
const GAP_X = 90;
const GAP_Y = 40;
const PAD = 24;

function layout(tables: ErdTable[], edges: ErdEdge[]) {
  // Layer = longest chain of references pointing at this table (referenced tables sit left).
  const refs = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.table === e.refTable) continue;
    if (!refs.has(e.table)) refs.set(e.table, new Set());
    refs.get(e.table)!.add(e.refTable);
  }
  const depth = new Map<string, number>();
  const visit = (name: string, seen: Set<string>): number => {
    if (depth.has(name)) return depth.get(name)!;
    if (seen.has(name)) return 0;
    seen.add(name);
    const parents = [...(refs.get(name) ?? [])];
    const d = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => visit(p, seen)));
    depth.set(name, d);
    return d;
  };
  for (const t of tables) visit(t.name, new Set());

  const columns = new Map<number, ErdTable[]>();
  for (const t of tables) {
    const d = depth.get(t.name) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(t);
  }
  const pos = new Map<string, { x: number; y: number; h: number }>();
  let maxH = 0;
  const layers = [...columns.keys()].sort((a, b) => a - b);
  for (const d of layers) {
    let y = PAD;
    for (const t of columns.get(d)!) {
      const h = HEAD_H + t.columns.length * ROW_H + 8;
      pos.set(t.name, { x: PAD + d * (BOX_W + GAP_X), y, h });
      y += h + GAP_Y;
    }
    maxH = Math.max(maxH, y);
  }
  const width = PAD * 2 + layers.length * BOX_W + Math.max(0, layers.length - 1) * GAP_X;
  return { pos, width, height: maxH + PAD };
}

function shortType(t: string): string {
  return t.replace('character varying', 'varchar').replace('timestamp with time zone', 'timestamptz').replace('timestamp without time zone', 'timestamp').replace('double precision', 'float8');
}

export function ErdDiagram({ tables, edges }: { tables: ErdTable[]; edges: ErdEdge[] }) {
  const [zoom, setZoom] = useState(1);
  const { pos, width, height } = useMemo(() => layout(tables, edges), [tables, edges]);

  if (tables.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No tables yet. The diagram appears once the app creates its first table.</p>;
  }

  const colY = (table: string, column: string) => {
    const t = tables.find((x) => x.name === table);
    const p = pos.get(table)!;
    const idx = Math.max(0, t?.columns.findIndex((c) => c.name === column) ?? 0);
    return p.y + HEAD_H + idx * ROW_H + ROW_H / 2;
  };

  return (
    <div className="relative rounded-xl border border-border/60 bg-background">
      <div className="absolute right-2 top-2 z-10 inline-flex items-center rounded-lg border border-border/60 bg-card">
        <button type="button" aria-label="Zoom out" className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-foreground" onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}><Minus className="h-3.5 w-3.5" /></button>
        <span className="w-10 text-center text-[11px] tabular-nums">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in" className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-foreground" onClick={() => setZoom((z) => Math.min(2, z + 0.1))}><Plus className="h-3.5 w-3.5" /></button>
      </div>
      <div className="overflow-auto max-h-[560px]">
        <svg width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`} className="block">
          <defs>
            <marker id="erd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-primary" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const from = pos.get(e.table); const to = pos.get(e.refTable);
            if (!from || !to) return null;
            const y1 = colY(e.table, e.column); const y2 = colY(e.refTable, e.refColumn);
            const leftward = to.x < from.x;
            const x1 = leftward ? from.x : from.x + BOX_W;
            const x2 = leftward ? to.x + BOX_W : to.x;
            const cx = (x1 + x2) / 2;
            return (
              <path key={i} d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`} fill="none" className="stroke-primary/70" strokeWidth={1.5} markerEnd="url(#erd-arrow)" />
            );
          })}
          {tables.map((t) => {
            const p = pos.get(t.name)!;
            return (
              <g key={t.name} transform={`translate(${p.x} ${p.y})`}>
                <rect width={BOX_W} height={p.h} rx={10} className="fill-card stroke-border" strokeWidth={1} />
                <rect width={BOX_W} height={HEAD_H} rx={10} className="fill-muted" />
                <rect y={HEAD_H - 10} width={BOX_W} height={10} className="fill-muted" />
                <text x={12} y={HEAD_H / 2 + 4} className="fill-foreground" fontSize={12} fontWeight={600} fontFamily="ui-monospace, monospace">{t.name}</text>
                {t.columns.map((c, i) => {
                  const y = HEAD_H + i * ROW_H;
                  const isFk = edges.some((e) => e.table === t.name && e.column === c.name);
                  return (
                    <g key={c.name} transform={`translate(0 ${y})`}>
                      {c.primary_key && <KeyRound x={10} y={5} width={11} height={11} className="text-amber-500" />}
                      {!c.primary_key && isFk && <Link2 x={10} y={5} width={11} height={11} className="text-primary" />}
                      <text x={26} y={ROW_H / 2 + 4} fontSize={11} fontFamily="ui-monospace, monospace" className={c.primary_key ? 'fill-foreground' : 'fill-foreground/85'}>{c.name}</text>
                      <text x={BOX_W - 10} y={ROW_H / 2 + 4} fontSize={10} textAnchor="end" className="fill-muted-foreground" fontFamily="ui-monospace, monospace">{shortType(c.type)}{c.nullable ? '?' : ''}</text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
