import { useEffect, useState } from 'react';
import { Plug, Plus, Pencil, Trash2, X } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';

interface Connector {
  id: string;
  name: string;
  type: string;
  status?: string;
  secrets?: Record<string, string>;
}

export default function ConnectorsPage() {
  const [rows, setRows] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingConnector, setEditingConnector] = useState<Connector | null>(null);
  const [deletingConnector, setDeletingConnector] = useState<Connector | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    ecgApi.connectors.list()
      .then(d => setRows(Array.isArray(d) ? d : (d.connectors ?? [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (connectorData: Partial<Connector>) => {
    setModalLoading(true);
    try {
      if (editingConnector?.id) {
        const updated = await ecgApi.connectors.update(editingConnector.id, connectorData);
        setRows(rows.map(c => c.id === editingConnector.id ? { ...c, ...updated } : c));
      } else {
        const created = await ecgApi.connectors.create(connectorData);
        setRows([...rows, created]);
      }
      setEditingConnector(null);
      setShowCreate(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setModalLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingConnector?.id) return;
    setModalLoading(true);
    try {
      await ecgApi.connectors.delete(deletingConnector.id);
      setRows(rows.filter(c => c.id !== deletingConnector.id));
      setDeletingConnector(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setModalLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Connectors</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
          style={{ background: 'var(--accent)' }}
        >
          <Plus className="w-4 h-4" /> New Connector
        </button>
      </div>

      {loading && <Spinner />}
      {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{error}</div>}
      {!loading && !rows.length && <div className="text-center py-16 text-sm" style={{ color: 'var(--muted)' }}>No connectors configured</div>}
      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {rows.map((c: Connector) => (
            <div key={c.id} className="rounded-xl border p-5" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--border)' }}>
                    <Plug className="w-4 h-4" style={{ color: 'var(--muted)' }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-sm truncate" style={{ color: 'var(--text)' }}>{c.name}</p>
                      <StatusBadge status={c.status ?? 'active'} />
                    </div>
                    <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--muted)' }}>{c.type}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setEditingConnector(c)}
                    className="p-1.5 rounded hover:bg-gray-100"
                    title="Edit"
                  >
                    <Pencil className="w-4 h-4 text-gray-600" />
                  </button>
                  <button
                    onClick={() => setDeletingConnector(c)}
                    className="p-1.5 rounded hover:bg-red-50"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4 text-red-600" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(showCreate || editingConnector) && (
        <ConnectorModal
          connector={editingConnector}
          onClose={() => {
            setShowCreate(false);
            setEditingConnector(null);
          }}
          onSave={handleSave}
          loading={modalLoading}
        />
      )}

      {deletingConnector && (
        <DeleteConfirmModal
          itemName={deletingConnector.name}
          onClose={() => setDeletingConnector(null)}
          onConfirm={handleDelete}
          loading={modalLoading}
        />
      )}
    </div>
  );
}

function Spinner() { return <div className="flex justify-center py-16"><span className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }

function ConnectorModal({ connector, onClose, onSave, loading }: {
  connector: Connector | null;
  onClose: () => void;
  onSave: (data: Partial<Connector>) => void;
  loading: boolean;
}) {
  const [name, setName] = useState(connector?.name ?? '');
  const [type, setType] = useState(connector?.type ?? 'custom');
  const [secrets, setSecrets] = useState(connector?.secrets ?? {});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !type) return;
    onSave({ name: name.trim(), type, secrets });
  };

  const addSecret = () => {
    const key = prompt('Enter secret key name:');
    if (!key) return;
    setSecrets({ ...secrets, [key]: '' });
  };

  const updateSecret = (key: string, value: string) => {
    setSecrets({ ...secrets, [key]: value });
  };

  const removeSecret = (key: string) => {
    const newSecrets = { ...secrets };
    delete newSecrets[key];
    setSecrets(newSecrets);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto" style={{ background: 'var(--card-bg)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
            {connector ? 'Edit Connector' : 'New Connector'}
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
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Type</label>
            <select
              value={type}
              onChange={e => setType(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              required
            >
              <option value="custom">Custom</option>
              <option value="webhook">Webhook</option>
              <option value="api">API</option>
              <option value="database">Database</option>
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium" style={{ color: 'var(--text)' }}>Secrets</label>
              <button
                type="button"
                onClick={addSecret}
                className="text-xs px-2 py-1 rounded border"
                style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
              >
                + Add Secret
              </button>
            </div>
            {Object.entries(secrets).length === 0 ? (
              <p className="text-xs py-4 text-center" style={{ color: 'var(--muted)' }}>No secrets configured</p>
            ) : (
              <div className="space-y-2">
                {Object.entries(secrets).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={key}
                      disabled
                      className="w-1/3 px-2 py-1.5 rounded text-xs border opacity-60"
                      style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
                    />
                    <input
                      type="password"
                      value={value as string}
                      onChange={e => updateSecret(key, e.target.value)}
                      className="flex-1 px-2 py-1.5 rounded text-xs border"
                      style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
                      placeholder="••••••••"
                    />
                    <button
                      type="button"
                      onClick={() => removeSecret(key)}
                      className="p-1 rounded text-red-600 hover:bg-red-50"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
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
              disabled={loading || !name.trim() || !type}
              className="flex-1 px-4 py-2 rounded-lg text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              {loading ? 'Saving...' : connector ? 'Save' : 'Create'}
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
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Delete Connector</h2>
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
