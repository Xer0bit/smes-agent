import { useEffect, useState } from 'react';
import { Upload, Trash2, Plus, FolderPlus, Pencil, X, Folder, Loader2, AlertCircle } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';

const TYPE_ICONS: Record<string, string> = { document: '📄', url: '🔗', text: '📝' };

// The proxy's GET /knowledge (ecgData.listKnowledge on the portal side) only
// returns {id, name, type, status, createdAt} — no file size and no kbId, so
// files can't be grouped/filtered by knowledge base or show a size here the
// way the real portal's Knowledge page does. Status badge + upload date are
// the real fields actually available.
const STATUS_CFG: Record<string, { label: string; color: string }> = {
  processing: { label: 'Indexing…', color: '#a16207' },
  ready:      { label: 'Ready',     color: 'var(--muted)' },
  error:      { label: 'Error',     color: '#dc2626' },
};

export default function KnowledgePage() {
  const [items, setItems] = useState<any[]>([]);
  const [bases, setBases] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showBaseModal, setShowBaseModal] = useState(false);
  const [editingBase, setEditingBase] = useState<any>(null);
  const [deletingItem, setDeletingItem] = useState<any>(null);
  const [deletingBase, setDeletingBase] = useState<any>(null);
  const [modalLoading, setModalLoading] = useState(false);

  useEffect(() => {
    Promise.all([
      ecgApi.knowledge.list().then(d => Array.isArray(d) ? d : (d.knowledge ?? d.items ?? [])),
      ecgApi.knowledgeBases.list().then(d => Array.isArray(d) ? d : [])
    ])
      .then(([itemsData, basesData]) => {
        setItems(itemsData);
        setBases(basesData);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleUpload = async (file: File, baseId?: string) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (baseId) formData.append('baseId', baseId);

      const created = await ecgApi.knowledge.upload(formData);
      setItems([...items, created]);
      setShowUpload(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteItem = async () => {
    if (!deletingItem?.id) return;
    setModalLoading(true);
    try {
      await ecgApi.knowledge.delete(deletingItem.id);
      setItems(items.filter(i => i.id !== deletingItem.id));
      setDeletingItem(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setModalLoading(false);
    }
  };

  const handleSaveBase = async (baseData: any) => {
    setModalLoading(true);
    try {
      if (editingBase?.id) {
        const updated = await ecgApi.knowledgeBases.update(editingBase.id, baseData);
        setBases(bases.map(b => b.id === editingBase.id ? { ...b, ...updated } : b));
      } else {
        const created = await ecgApi.knowledgeBases.create(baseData);
        setBases([...bases, created]);
      }
      setEditingBase(null);
      setShowBaseModal(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setModalLoading(false);
    }
  };

  const handleDeleteBase = async () => {
    if (!deletingBase?.id) return;
    setModalLoading(true);
    try {
      await ecgApi.knowledgeBases.delete(deletingBase.id);
      setBases(bases.filter(b => b.id !== deletingBase.id));
      setDeletingBase(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setModalLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Knowledge</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowBaseModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border"
            style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
          >
            <FolderPlus className="w-4 h-4" /> New Base
          </button>
          <button
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ background: 'var(--accent)' }}
          >
            <Upload className="w-4 h-4" /> Upload File
          </button>
        </div>
      </div>

      {loading && <Spinner />}
      {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{error}</div>}

      {/* Knowledge Bases */}
      {!loading && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium" style={{ color: 'var(--text)' }}>Knowledge Bases</h2>
          {!bases.length && <div className="text-center py-8 text-sm" style={{ color: 'var(--muted)' }}>No knowledge bases configured</div>}
          {bases.map((b: any) => (
            <div key={b.id} className="rounded-xl border px-5 py-3 flex items-center justify-between gap-3"
              style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Folder className="w-4 h-4 shrink-0" style={{ color: 'var(--muted)' }} />
                <div>
                  <p className="font-medium text-sm" style={{ color: 'var(--text)' }}>{b.name}</p>
                  {b.description && <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{b.description}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEditingBase(b)}
                  className="p-1 rounded hover:bg-gray-100"
                  title="Edit"
                >
                  <Pencil className="w-4 h-4 text-gray-600" />
                </button>
                <button
                  onClick={() => setDeletingBase(b)}
                  className="p-1 rounded hover:bg-red-50"
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4 text-red-600" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Knowledge Items */}
      {!loading && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium" style={{ color: 'var(--text)' }}>Files & Documents</h2>
          {!items.length && <div className="text-center py-8 text-sm" style={{ color: 'var(--muted)' }}>No knowledge assets found</div>}
          {items.map((k: any) => {
            const statusCfg = STATUS_CFG[k.status as string] ?? STATUS_CFG.ready;
            return (
            <div key={k.id} className="rounded-xl border px-5 py-4 flex items-center justify-between gap-4"
              style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-4 flex-1 min-w-0">
                <span className="text-xl">
                  {k.status === 'processing' ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--muted)' }} />
                    : k.status === 'error' ? <AlertCircle className="w-4 h-4" style={{ color: '#dc2626' }} />
                    : (TYPE_ICONS[k.type] ?? '📄')}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate" style={{ color: 'var(--text)' }}>{k.title ?? k.name ?? 'Untitled'}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs capitalize" style={{ color: 'var(--muted)' }}>{k.type ?? 'document'}</span>
                    {k.createdAt && <span className="text-xs" style={{ color: 'var(--muted)' }}>· Uploaded {new Date(k.createdAt).toLocaleDateString()}</span>}
                    <span className="text-xs font-medium" style={{ color: statusCfg.color }}>· {statusCfg.label}</span>
                  </div>
                </div>
                {k.agentName && <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>{k.agentName}</span>}
              </div>
              <button
                onClick={() => setDeletingItem(k)}
                className="p-1 rounded hover:bg-red-50 shrink-0"
                title="Delete"
              >
                <Trash2 className="w-4 h-4 text-red-600" />
              </button>
            </div>
            );
          })}
        </div>
      )}

      {showUpload && (
        <UploadModal
          bases={bases}
          onClose={() => setShowUpload(false)}
          onUpload={handleUpload}
          loading={uploading}
        />
      )}

      {(showBaseModal || editingBase) && (
        <KnowledgeBaseModal
          base={editingBase}
          onClose={() => {
            setShowBaseModal(false);
            setEditingBase(null);
          }}
          onSave={handleSaveBase}
          loading={modalLoading}
        />
      )}

      {deletingItem && (
        <DeleteConfirmModal
          itemName={deletingItem.title ?? deletingItem.name ?? 'this file'}
          onClose={() => setDeletingItem(null)}
          onConfirm={handleDeleteItem}
          loading={modalLoading}
        />
      )}

      {deletingBase && (
        <DeleteConfirmModal
          itemName={deletingBase.name}
          onClose={() => setDeletingBase(null)}
          onConfirm={handleDeleteBase}
          loading={modalLoading}
        />
      )}
    </div>
  );
}

function Spinner() { return <div className="flex justify-center py-16"><span className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }

function UploadModal({ bases, onClose, onUpload, loading }: {
  bases: any[];
  onClose: () => void;
  onUpload: (file: File, baseId?: string) => void;
  loading: boolean;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [baseId, setBaseId] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    onUpload(file, baseId || undefined);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Upload Knowledge File</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>File</label>
            <input
              type="file"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Knowledge Base (optional)</label>
            <select
              value={baseId}
              onChange={e => setBaseId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
            >
              <option value="">No base</option>
              {bases.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-lg border"
              style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !file}
              className="flex-1 px-4 py-2 rounded-lg text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              {loading ? 'Uploading...' : 'Upload'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function KnowledgeBaseModal({ base, onClose, onSave, loading }: {
  base: any;
  onClose: () => void;
  onSave: (data: any) => void;
  loading: boolean;
}) {
  const [name, setName] = useState(base?.name ?? '');
  const [description, setDescription] = useState(base?.description ?? '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({ name: name.trim(), description });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
            {base ? 'Edit Knowledge Base' : 'New Knowledge Base'}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Description (optional)</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 resize-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-lg border"
              style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="flex-1 px-4 py-2 rounded-lg text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              {loading ? 'Saving...' : base ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteConfirmModal({ itemName, onClose, onConfirm, loading }: {
  itemName: string;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Delete Item</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Are you sure you want to delete <strong>{itemName}</strong>? This action cannot be undone.
        </p>
        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 px-4 py-2 rounded-lg border"
            style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 px-4 py-2 rounded-lg text-white bg-red-600 disabled:opacity-50"
          >
            {loading ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
