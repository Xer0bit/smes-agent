import { useEffect, useState } from 'react';
import { Upload, Trash2, FolderPlus, Pencil, X, Folder, Loader2, AlertCircle, FileText } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { PageHeader, Card, EmptyState, Spinner, SectionHeader } from '../components/ui';

const TYPE_ICONS: Record<string, string> = { document: '📄', url: '🔗', text: '📝' };

// The proxy's GET /knowledge (ecgData.listKnowledge on the portal side) only
// returns {id, name, type, status, createdAt}   no file size and no kbId, so
// files can't be grouped/filtered by knowledge base or show a size here the
// way the real portal's Knowledge page does. Status badge + upload date are
// the real fields actually available.
const STATUS_CFG: Record<string, { label: string; color: string }> = {
  processing: { label: 'Indexing…', color: 'var(--warning)' },
  ready:      { label: 'Ready',     color: 'var(--muted)' },
  error:      { label: 'Error',     color: 'var(--danger)' },
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
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <PageHeader eyebrow="System" title="Knowledge" action={
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowBaseModal(true)}
            className="flex items-center gap-2 px-4 py-2 font-medium border"
            style={{ borderColor: 'var(--border)', color: 'var(--text)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}
          >
            <FolderPlus className="w-4 h-4" /> New Base
          </button>
          <button
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-2 px-4 py-2 font-medium text-white hover:opacity-90"
            style={{ background: 'var(--accent)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}
          >
            <Upload className="w-4 h-4" /> Upload File
          </button>
        </div>
      } />

      {loading && <Spinner />}
      {error && <div className="px-4 py-3" style={{ fontSize: 'var(--text-small)', color: 'var(--danger)', background: 'var(--danger-bg)', borderRadius: 'var(--radius)' }}>{error}</div>}

      {/* Knowledge Bases */}
      {!loading && (
        <Card className="p-5">
          <SectionHeader title="Knowledge Bases" />
          {!bases.length ? (
            <p className="py-2" style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>No knowledge bases configured</p>
          ) : (
            <div className="space-y-2">
              {bases.map((b: any) => (
                <div key={b.id} className="flex items-center justify-between gap-3 border px-4 py-3" style={{ borderColor: 'var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Folder className="w-4 h-4 shrink-0" style={{ color: 'var(--muted)' }} />
                    <div>
                      <p className="font-medium" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>{b.name}</p>
                      {b.description && <p className="mt-0.5" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>{b.description}</p>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => setEditingBase(b)} className="p-1.5 rounded hover:bg-[var(--accent-bg)]" title="Edit">
                      <Pencil className="w-4 h-4" style={{ color: 'var(--muted)' }} />
                    </button>
                    <button onClick={() => setDeletingBase(b)} className="p-1.5 rounded hover:bg-red-500/10" title="Delete">
                      <Trash2 className="w-4 h-4" style={{ color: 'var(--danger)' }} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Knowledge Items */}
      {!loading && (
        !items.length ? (
          <EmptyState Icon={FileText} title="No knowledge assets found"
            hint="Upload a document, URL, or note so your agents can reference it when writing." />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {items.map((k: any) => {
              const statusCfg = STATUS_CFG[k.status as string] ?? STATUS_CFG.ready;
              return (
              <Card key={k.id} hover className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <span style={{ fontSize: 'var(--text-lg)' }}>
                      {k.status === 'processing' ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--muted)' }} />
                        : k.status === 'error' ? <AlertCircle className="w-4 h-4" style={{ color: 'var(--danger)' }} />
                        : (TYPE_ICONS[k.type] ?? '📄')}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold truncate" style={{ fontSize: 'var(--text-body)', color: 'var(--text)' }}>{k.title ?? k.name ?? 'Untitled'}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="capitalize" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>{k.type ?? 'document'}</span>
                        {k.createdAt && <span style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>· Uploaded {new Date(k.createdAt).toLocaleDateString()}</span>}
                        <span className="font-medium" style={{ fontSize: 'var(--text-tiny)', color: statusCfg.color }}>· {statusCfg.label}</span>
                      </div>
                      {k.agentName && <p className="mt-0.5" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>{k.agentName}</p>}
                    </div>
                  </div>
                  <button onClick={() => setDeletingItem(k)} className="p-1.5 rounded hover:bg-red-500/10 shrink-0" title="Delete">
                    <Trash2 className="w-4 h-4" style={{ color: 'var(--danger)' }} />
                  </button>
                </div>
              </Card>
              );
            })}
          </div>
        )
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
      <div className="w-full max-w-md p-6 space-y-4" style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center justify-between">
          <h2 style={{ fontSize: 'var(--text-lg)', color: 'var(--text)' }}>Upload Knowledge File</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--accent-bg)]">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>File</label>
            <input
              type="file"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
              className="w-full px-3 py-2 border focus:outline-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
              required
            />
          </div>

          <div>
            <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>Knowledge Base (optional)</label>
            <select
              value={baseId}
              onChange={e => setBaseId(e.target.value)}
              className="w-full px-3 py-2 border focus:outline-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
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
              className="flex-1 px-4 py-2 border"
              style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !file}
              className="flex-1 px-4 py-2 text-white hover:opacity-90 disabled:opacity-50"
              style={{ background: 'var(--accent)', borderRadius: 'var(--radius-sm)' }}
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
      <div className="w-full max-w-md p-6 space-y-4" style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center justify-between">
          <h2 style={{ fontSize: 'var(--text-lg)', color: 'var(--text)' }}>
            {base ? 'Edit Knowledge Base' : 'New Knowledge Base'}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--accent-bg)]">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 border focus:outline-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
              autoFocus
            />
          </div>

          <div>
            <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>Description (optional)</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border focus:outline-none resize-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border"
              style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="flex-1 px-4 py-2 text-white hover:opacity-90 disabled:opacity-50"
              style={{ background: 'var(--accent)', borderRadius: 'var(--radius-sm)' }}
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
      <div className="w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)' }}>
        <h2 style={{ fontSize: 'var(--text-lg)', color: 'var(--text)' }}>Delete Item</h2>
        <p style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>
          Are you sure you want to delete <strong>{itemName}</strong>? This action cannot be undone.
        </p>
        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 px-4 py-2 border"
            style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 px-4 py-2 text-white hover:opacity-90 disabled:opacity-50"
            style={{ background: 'var(--danger)', borderRadius: 'var(--radius-sm)' }}
          >
            {loading ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
