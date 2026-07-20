import { useEffect, useState } from 'react';
import { Plug, Zap, MessageCircle, Linkedin, Plus, Pencil, Trash2, X, RefreshCw, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';

interface Connector {
  id: string;
  name: string;
  type: string;
  status?: string;
  apiKey?: string; api_key?: string;
  phone?: string;
}

// Matches the real connector model (org_connectors table)   type-specific
// fields, not the generic custom-secrets-map this form used to submit
// (which the backend's POST /connectors/org never accepted at all).
const CONNECTOR_TYPES = [
  { value: 'zapier', label: 'Zapier MCP', Icon: Zap },
  { value: 'whatsapp', label: 'WhatsApp Business', Icon: MessageCircle },
  { value: 'zapier-mcp-linkedin', label: 'LinkedIn (Zapier MCP)', Icon: Linkedin },
];
function typeMeta(type: string) {
  return CONNECTOR_TYPES.find(t => t.value === type) ?? { value: type, label: type, Icon: Plug };
}

const STATUS_CFG: Record<string, { label: string; color: string; Icon: typeof CheckCircle }> = {
  connected:    { label: 'Connected',    color: '#16a34a', Icon: CheckCircle },
  disconnected: { label: 'Disconnected', color: 'var(--muted)', Icon: XCircle },
  error:        { label: 'Error',        color: '#dc2626', Icon: AlertCircle },
};

export default function ConnectorsPage() {
  const [rows, setRows] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingConnector, setEditingConnector] = useState<Connector | null>(null);
  const [deletingConnector, setDeletingConnector] = useState<Connector | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 4000); }

  useEffect(() => {
    ecgApi.connectors.list()
      .then(d => setRows(Array.isArray(d) ? d : (d.connectors ?? [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (connectorData: Record<string, unknown>) => {
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

  const handleTest = async (c: Connector) => {
    setTestingId(c.id);
    try {
      const res: any = await ecgApi.connectors.test(c.id);
      showToast(res?.note ?? `${c.name} connection verified`);
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : `${c.name} test failed`);
    } finally {
      setTestingId(null);
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
          {rows.map((c: Connector) => {
            const meta = typeMeta(c.type);
            const statusCfg = STATUS_CFG[c.status ?? 'disconnected'] ?? STATUS_CFG.disconnected;
            return (
            <div key={c.id} className="rounded-xl border p-5" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--accent-bg,#ede9fe)' }}>
                    <meta.Icon className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate" style={{ color: 'var(--text)' }}>{c.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{meta.label}</p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border shrink-0" style={{ borderColor: 'var(--border)', color: statusCfg.color }}>
                  <statusCfg.Icon className="w-3 h-3" /> {statusCfg.label}
                </span>
              </div>
              <div className="flex gap-2 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                <button onClick={() => handleTest(c)} disabled={testingId === c.id}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border disabled:opacity-50" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
                  <RefreshCw className={`w-3 h-3 ${testingId === c.id ? 'animate-spin' : ''}`} /> {testingId === c.id ? 'Testing…' : 'Test'}
                </button>
                <button onClick={() => setEditingConnector(c)} className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
                  <Pencil className="w-3 h-3" /> Edit
                </button>
                <button onClick={() => setDeletingConnector(c)} className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border ml-auto text-red-600" style={{ borderColor: 'var(--border)' }}>
                  <Trash2 className="w-3 h-3" /> Remove
                </button>
              </div>
            </div>
            );
          })}
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

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 border text-sm px-5 py-3 rounded-xl shadow-2xl z-50 max-w-sm text-center"
          style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function Spinner() { return <div className="flex justify-center py-16"><span className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }

function ConnectorModal({ connector, onClose, onSave, loading }: {
  connector: Connector | null;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
  loading: boolean;
}) {
  const [name, setName] = useState(connector?.name ?? '');
  const [type, setType] = useState(connector?.type ?? 'zapier');
  const [apiKey, setApiKey] = useState('');
  const [phone, setPhone] = useState(connector?.phone ?? '');

  const isZapier = type === 'zapier' || type.startsWith('zapier-mcp');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !type) return;
    const payload: Record<string, unknown> = { name: name.trim(), type };
    if (isZapier && apiKey.trim()) payload.api_key = apiKey.trim();
    if (type === 'whatsapp') payload.phone = phone.trim();
    onSave(payload);
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
              {CONNECTOR_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          {isZapier && (
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Zapier MCP Token</label>
              <input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={connector ? 'Leave blank to keep current token' : 'Paste your token from zapier.com/mcp'}
                className="w-full px-3 py-2 rounded-lg border font-mono text-xs focus:outline-none focus:ring-2"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              />
            </div>
          )}

          {type === 'whatsapp' && (
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Phone Number</label>
              <input
                type="text"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="+15551234567"
                className="w-full px-3 py-2 rounded-lg border font-mono text-xs focus:outline-none focus:ring-2"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              />
            </div>
          )}

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
