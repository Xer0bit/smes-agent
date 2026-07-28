import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Image as ImageIcon, Wand2, Trash2, Type, Square, Circle, X } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';

// Canva-style canvas editor for a post visual: a background plus a flat list
// of individually positioned objects (text/image/shape), each directly
// draggable/resizable. Mirrors the eCG Agents Portal's own visual editor  
// same data model, ported here so dashboards built from this template get
// the same capability against the same backend routes.

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const HANDLE_SIZE = 10;

interface DragInfo {
  mode: 'move' | 'resize';
  id: string;
  corner?: Corner;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
}

function newTextObject(canvasWidth: number): any {
  return { id: `text-${Date.now()}`, type: 'text', x: 40, y: 40, width: Math.min(400, canvasWidth - 80), height: 80, zIndex: 10, text: 'New text', fontSize: 32, fontWeight: 700, color: '#1e293b', textAlign: 'left' };
}
function newShapeObject(): any {
  return { id: `shape-${Date.now()}`, type: 'shape', x: 40, y: 40, width: 200, height: 100, zIndex: 1, shape: 'rect', fill: '#2563eb', opacity: 1 };
}
function newImageObject(): any {
  return { id: `image-${Date.now()}`, type: 'image', x: 40, y: 40, width: 200, height: 200, zIndex: 5, src: '', objectFit: 'cover' };
}

export default function VisualEditorPage() {
  const { id, postId } = useParams<{ id?: string; postId?: string }>();
  const navigate = useNavigate();

  const [visual, setVisual] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [objects, setObjects] = useState<any[]>([]);
  const [background, setBackground] = useState('#ffffff');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [stylePrompt, setStylePrompt] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  const dragInfo = useRef<DragInfo | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [workspaceSize, setWorkspaceSize] = useState({ width: 800, height: 600 });

  // Two entry points: /posts/:postId/visual (generate-or-open for a planned
  // post) and /visuals/:id (open an existing visual directly).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        if (id) {
          const v = await ecgApi.visualPosts.get(id);
          if (!cancelled) setVisual(v);
        } else if (postId) {
          const existing = await ecgApi.visualPosts.list(postId);
          const list = Array.isArray(existing) ? existing : (existing.visuals ?? []);
          if (list.length > 0) {
            if (!cancelled) setVisual(list[0]);
          } else {
            const allPosts = await ecgApi.posts.list();
            const posts = Array.isArray(allPosts) ? allPosts : (allPosts.posts ?? allPosts.plannedPosts ?? []);
            const post = posts.find((p: any) => p.id === postId);
            const v = await ecgApi.visualPosts.generate({
              plannedPostId: postId,
              agentId: post?.agentId ?? post?.agent_id,
              postContent: post?.content || 'Untitled post',
              platform: post?.platform ?? 'linkedin',
            });
            if (!cancelled) { setVisual(v); navigate(`/visuals/${v.id}`, { replace: true }); }
          }
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'Failed to load visual');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, postId]);

  useEffect(() => {
    if (visual) { setObjects(visual.objects ?? []); setBackground(visual.background ?? '#ffffff'); setSelectedId(null); }
  }, [visual?.id, visual?.updatedAt]);

  useEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setWorkspaceSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = useMemo(() => {
    if (!visual) return 1;
    const pad = 48;
    const availW = Math.max(100, workspaceSize.width - pad * 2);
    const availH = Math.max(100, workspaceSize.height - pad * 2);
    return Math.min(availW / visual.width, availH / visual.height, 1);
  }, [visual, workspaceSize]);

  const selected = objects.find(o => o.id === selectedId) ?? null;
  const dirty = useMemo(() => {
    if (!visual) return false;
    return JSON.stringify(objects) !== JSON.stringify(visual.objects) || background !== visual.background;
  }, [objects, background, visual]);

  const updateObject = useCallback((objId: string, patch: any) => {
    setObjects(prev => prev.map(o => (o.id === objId ? { ...o, ...patch } : o)));
  }, []);

  const deleteObject = (objId: string) => {
    setObjects(prev => prev.filter(o => o.id !== objId));
    if (selectedId === objId) setSelectedId(null);
  };

  const onPointerMove = useCallback((e: PointerEvent) => {
    const info = dragInfo.current;
    if (!info) return;
    const dx = (e.clientX - info.startClientX) / scale;
    const dy = (e.clientY - info.startClientY) / scale;
    if (info.mode === 'move') {
      updateObject(info.id, { x: Math.round(info.startX + dx), y: Math.round(info.startY + dy) });
      return;
    }
    let nx = info.startX, ny = info.startY, nw = info.startW, nh = info.startH;
    const c = info.corner!;
    if (c.includes('e')) nw = Math.max(20, info.startW + dx);
    if (c.includes('s')) nh = Math.max(20, info.startH + dy);
    if (c.includes('w')) { nw = Math.max(20, info.startW - dx); nx = info.startX + dx; }
    if (c.includes('n')) { nh = Math.max(20, info.startH - dy); ny = info.startY + dy; }
    updateObject(info.id, { x: Math.round(nx), y: Math.round(ny), width: Math.round(nw), height: Math.round(nh) });
  }, [scale, updateObject]);

  const onPointerUp = useCallback(() => {
    dragInfo.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);

  const startMove = (e: React.PointerEvent, obj: any) => {
    e.stopPropagation();
    if (editingTextId === obj.id) return;
    setSelectedId(obj.id);
    dragInfo.current = { mode: 'move', id: obj.id, startClientX: e.clientX, startClientY: e.clientY, startX: obj.x, startY: obj.y, startW: obj.width, startH: obj.height };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };
  const startResize = (e: React.PointerEvent, obj: any, corner: Corner) => {
    e.stopPropagation();
    dragInfo.current = { mode: 'resize', id: obj.id, corner, startClientX: e.clientX, startClientY: e.clientY, startX: obj.x, startY: obj.y, startW: obj.width, startH: obj.height };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  useEffect(() => () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove, onPointerUp]);

  const handleSave = async () => {
    if (!visual) return;
    setSaving(true); setError('');
    try { setVisual(await ecgApi.visualPosts.update(visual.id, { objects, background })); }
    catch (e: any) { setError(e.message ?? 'Failed to save'); }
    finally { setSaving(false); }
  };

  const handleRegenerate = async () => {
    if (!visual || !stylePrompt.trim()) return;
    setRegenerating(true); setError('');
    try {
      setVisual(await ecgApi.visualPosts.regenerate(visual.id, { postContent: stylePrompt, stylePrompt }));
      setStylePrompt(''); setShowPrompt(false);
    } catch (e: any) { setError(e.message ?? 'Failed to regenerate'); }
    finally { setRegenerating(false); }
  };

  const handleFinalize = async () => {
    if (!visual) return;
    setFinalizing(true); setError('');
    try {
      if (dirty) await ecgApi.visualPosts.update(visual.id, { objects, background });
      setVisual(await ecgApi.visualPosts.finalize(visual.id));
    } catch (e: any) { setError(e.message ?? 'Failed to finalize'); }
    finally { setFinalizing(false); }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full"><span className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent)' }} /></div>;
  }
  if (error && !visual) {
    return <div className="flex items-center justify-center h-full"><p style={{ fontSize: 'var(--text-small)', color: 'var(--danger)' }}>{error}</p></div>;
  }
  if (!visual) return null;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2.5 border-b shrink-0" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => navigate(-1)} className="p-1.5 hover:opacity-70 shrink-0" style={{ color: 'var(--muted)', borderRadius: 'var(--radius-sm)' }}>
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <p className="font-medium truncate capitalize" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>{visual.platform} post visual</p>
            <p style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>{visual.width}×{visual.height}px · {visual.status === 'finalized' ? 'Finalized' : 'Draft'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setShowPrompt(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 font-medium border"
            style={showPrompt ? { fontSize: 'var(--text-tiny)', background: 'var(--accent-bg)', borderColor: 'var(--accent)', color: 'var(--accent)', borderRadius: 'var(--radius-sm)' } : { fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', color: 'var(--muted)', borderRadius: 'var(--radius-sm)' }}>
            <Wand2 className="w-3.5 h-3.5" /> Regenerate
          </button>
          <button onClick={handleSave} disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 font-medium border disabled:opacity-50"
            style={{ fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>
            <Save className="w-3.5 h-3.5" /> Save
          </button>
          <button onClick={handleFinalize} disabled={finalizing}
            className="flex items-center gap-1.5 px-4 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
            style={{ background: 'var(--accent)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius-sm)' }}>
            <ImageIcon className="w-4 h-4" /> Finalize
          </button>
        </div>
      </div>

      {error && <div className="px-4 py-2 shrink-0" style={{ fontSize: 'var(--text-tiny)', color: 'var(--danger)', background: 'var(--danger-bg)', borderBottom: '1px solid var(--border)' }}>{error}</div>}

      {showPrompt && (
        <div className="flex items-center gap-2 px-4 py-2.5 shrink-0" style={{ background: 'var(--accent-bg)', borderBottom: '1px solid var(--border)' }}>
          <input autoFocus value={stylePrompt} onChange={e => setStylePrompt(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleRegenerate()}
            placeholder="Describe a new direction..."
            className="flex-1 px-3 py-1.5 border focus:outline-none"
            style={{ fontSize: 'var(--text-small)', borderColor: 'var(--border)', background: 'var(--card-bg)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }} />
          <button onClick={handleRegenerate} disabled={!stylePrompt.trim() || regenerating}
            className="flex items-center gap-1.5 px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50" style={{ background: 'var(--accent)', fontSize: 'var(--text-tiny)', borderRadius: 'var(--radius-sm)' }}>
            <Wand2 className="w-3.5 h-3.5" /> Regenerate
          </button>
          <button onClick={() => setShowPrompt(false)} className="p-1.5" style={{ color: 'var(--muted)', borderRadius: 'var(--radius-sm)' }}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="w-14 border-r flex flex-col items-center py-3 gap-1 shrink-0" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
          <button title="Add text" onClick={() => { const o = newTextObject(visual.width); setObjects(p => [...p, o]); setSelectedId(o.id); }}
            className="w-11 h-11 flex items-center justify-center hover:opacity-70"  style={{ color: 'var(--muted)' }}><Type className="w-5 h-5" /></button>
          <button title="Add shape" onClick={() => { const o = newShapeObject(); setObjects(p => [...p, o]); setSelectedId(o.id); }}
            className="w-11 h-11 flex items-center justify-center hover:opacity-70"  style={{ color: 'var(--muted)' }}><Square className="w-5 h-5" /></button>
          <button title="Add image" onClick={() => { const o = newImageObject(); setObjects(p => [...p, o]); setSelectedId(o.id); }}
            className="w-11 h-11 flex items-center justify-center hover:opacity-70"  style={{ color: 'var(--muted)' }}><ImageIcon className="w-5 h-5" /></button>
        </div>

        <div ref={workspaceRef} className="flex-1 min-w-0 flex items-center justify-center overflow-auto" style={{ background: 'var(--body-bg)' }}>
          <div onPointerDown={() => setSelectedId(null)}
            style={{ width: visual.width * scale, height: visual.height * scale, background, boxShadow: 'var(--shadow-md)' }}
            className="relative overflow-hidden select-none shrink-0">
            {objects.map(o => (
              <div key={o.id} onPointerDown={e => startMove(e, o)} onDoubleClick={() => o.type === 'text' && setEditingTextId(o.id)}
                style={{
                  position: 'absolute', left: o.x * scale, top: o.y * scale, width: o.width * scale, height: o.height * scale,
                  zIndex: o.zIndex ?? 0, cursor: editingTextId === o.id ? 'text' : 'move',
                  outline: selectedId === o.id ? '2px solid var(--accent)' : 'none', outlineOffset: 1,
                }}>
                {o.type === 'text' && (
                  editingTextId === o.id ? (
                    <textarea autoFocus value={o.text ?? ''} onChange={e => updateObject(o.id, { text: e.target.value })}
                      onBlur={() => setEditingTextId(null)} onPointerDown={e => e.stopPropagation()}
                      style={{ width: '100%', height: '100%', resize: 'none', background: 'transparent', fontSize: (o.fontSize ?? 16) * scale, fontWeight: o.fontWeight, color: o.color, textAlign: o.textAlign, lineHeight: o.lineHeight, border: '1px dashed var(--accent)', outline: 'none', padding: 0 }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', overflow: 'hidden', fontSize: (o.fontSize ?? 16) * scale, fontWeight: o.fontWeight, color: o.color, textAlign: o.textAlign, lineHeight: o.lineHeight ?? 1.3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{o.text}</div>
                  )
                )}
                {o.type === 'image' && (
                  o.src ? <img src={o.src} draggable={false} alt="" style={{ width: '100%', height: '100%', objectFit: o.objectFit ?? 'cover', borderRadius: o.borderRadius, opacity: o.opacity ?? 1 }} />
                    : <div className="w-full h-full flex items-center justify-center text-xs border border-dashed" style={{ background: 'var(--border)', color: 'var(--muted)' }}>No image</div>
                )}
                {o.type === 'shape' && (
                  <div style={{ width: '100%', height: '100%', background: o.fill, opacity: o.opacity ?? 1, borderRadius: o.shape === 'ellipse' ? '50%' : (o.borderRadius ?? 0) }} />
                )}
                {selectedId === o.id && editingTextId !== o.id && (['nw', 'ne', 'sw', 'se'] as Corner[]).map(corner => (
                  <div key={corner} onPointerDown={e => startResize(e, o, corner)}
                    style={{
                      position: 'absolute', width: HANDLE_SIZE, height: HANDLE_SIZE, background: 'var(--accent)', border: '2px solid white', borderRadius: '50%', boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                      cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize',
                      top: corner.includes('n') ? -HANDLE_SIZE / 2 : undefined, bottom: corner.includes('s') ? -HANDLE_SIZE / 2 : undefined,
                      left: corner.includes('w') ? -HANDLE_SIZE / 2 : undefined, right: corner.includes('e') ? -HANDLE_SIZE / 2 : undefined,
                    }} />
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="w-72 border-l flex flex-col shrink-0 overflow-y-auto" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
          <div className="p-4 space-y-4">
            {selected ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="font-semibold uppercase flex items-center gap-1.5 min-w-0" style={{ fontSize: 'var(--text-tiny)', letterSpacing: 'var(--tracking-wide)', color: 'var(--text)' }}>
                    {selected.type === 'text' && <Type className="w-3.5 h-3.5 shrink-0" />}
                    {selected.type === 'image' && <ImageIcon className="w-3.5 h-3.5 shrink-0" />}
                    {selected.type === 'shape' && (selected.shape === 'ellipse' ? <Circle className="w-3.5 h-3.5 shrink-0" /> : <Square className="w-3.5 h-3.5 shrink-0" />)}
                    <span className="truncate">{selected.id}</span>
                  </p>
                  <button onClick={() => deleteObject(selected.id)} className="p-1 rounded hover:bg-red-500/10 shrink-0"><Trash2 className="w-3.5 h-3.5" style={{ color: 'var(--danger)' }} /></button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {(['width', 'height', 'x', 'y'] as const).map(field => (
                    <div key={field}>
                      <label className="block mb-1 capitalize" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>{field}</label>
                      <input type="number" value={Math.round(selected[field])} onChange={e => updateObject(selected.id, { [field]: field === 'width' || field === 'height' ? Math.max(10, +e.target.value) : +e.target.value })}
                        className="w-full px-2 py-1 rounded border" style={{ fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', background: 'var(--card-bg)', color: 'var(--text)' }} />
                    </div>
                  ))}
                </div>
                {selected.type === 'text' && (
                  <>
                    <div>
                      <label className="block mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Text</label>
                      <textarea value={selected.text ?? ''} onChange={e => updateObject(selected.id, { text: e.target.value })} rows={2}
                        className="w-full px-2 py-1.5 rounded border resize-none" style={{ fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', background: 'var(--card-bg)', color: 'var(--text)' }} />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="block mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Font Size</label>
                        <input type="number" value={selected.fontSize ?? 16} onChange={e => updateObject(selected.id, { fontSize: +e.target.value })}
                          className="w-full px-2 py-1 rounded border" style={{ fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', background: 'var(--card-bg)', color: 'var(--text)' }} />
                      </div>
                      <div>
                        <label className="block mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Color</label>
                        <input type="color" value={selected.color ?? '#000000'} onChange={e => updateObject(selected.id, { color: e.target.value })}
                          className="w-full h-7 rounded border cursor-pointer" style={{ borderColor: 'var(--border)' }} />
                      </div>
                    </div>
                  </>
                )}
                {selected.type === 'image' && (
                  <div>
                    <label className="block mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Image URL</label>
                    <input type="text" value={selected.src ?? ''} onChange={e => updateObject(selected.id, { src: e.target.value })}
                      placeholder="https://..." className="w-full px-2 py-1.5 rounded border font-mono" style={{ fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', background: 'var(--card-bg)', color: 'var(--text)' }} />
                  </div>
                )}
                {selected.type === 'shape' && (
                  <div>
                    <label className="block mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Fill</label>
                    <input type="color" value={selected.fill ?? '#2563eb'} onChange={e => updateObject(selected.id, { fill: e.target.value })}
                      className="w-full h-7 rounded border cursor-pointer" style={{ borderColor: 'var(--border)' }} />
                  </div>
                )}
                <div>
                  <label className="block mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Canvas Background</label>
                  <input type="color" value={/^#/.test(background) ? background : '#ffffff'} onChange={e => setBackground(e.target.value)}
                    className="w-full h-7 rounded border cursor-pointer" style={{ borderColor: 'var(--border)' }} />
                </div>
              </div>
            ) : (
              <>
                <div>
                  <label className="block mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Canvas Background</label>
                  <input type="color" value={/^#/.test(background) ? background : '#ffffff'} onChange={e => setBackground(e.target.value)}
                    className="w-full h-8 rounded border cursor-pointer" style={{ borderColor: 'var(--border)' }} />
                </div>
                <p className="text-center py-2" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Click an object to edit it.</p>
              </>
            )}
          </div>
          <div className="px-4 pb-4 mt-auto">
            <p className="font-semibold mb-1.5 uppercase" style={{ fontSize: 'var(--text-tiny)', letterSpacing: 'var(--tracking-wide)', color: 'var(--muted)' }}>Layers · {objects.length}</p>
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {objects.map(o => (
                <button key={o.id} onClick={() => setSelectedId(o.id)}
                  className="w-full text-left px-2 py-1.5 rounded-md flex items-center gap-2"
                  style={selectedId === o.id ? { background: 'var(--accent-bg)', color: 'var(--accent)', fontSize: 'var(--text-tiny)' } : { color: 'var(--muted)', fontSize: 'var(--text-tiny)' }}>
                  {o.type === 'text' && <Type className="w-3 h-3 shrink-0" />}
                  {o.type === 'image' && <ImageIcon className="w-3 h-3 shrink-0" />}
                  {o.type === 'shape' && <Square className="w-3 h-3 shrink-0" />}
                  <span className="truncate">{o.id}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
