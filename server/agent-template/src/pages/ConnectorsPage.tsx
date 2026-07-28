import { useEffect, useState } from 'react';
import {
  Plug, Zap, MessageCircle, Linkedin, Twitter, Instagram, Facebook, Youtube,
  Music2, AtSign, Pin, Send, Calendar, Scissors,
  Plus, Pencil, Trash2, X, RefreshCw, CheckCircle, XCircle, AlertCircle, Search,
} from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { PageHeader, Card, EmptyState, Spinner, platformMeta } from '../components/ui';
import { platformsForConnector } from './PostsPage';

interface Connector {
  id: string;
  name: string;
  type: string;
  status?: string;
  apiKey?: string; api_key?: string;
  phone?: string;
  platforms?: string[];
}

// Every platform Zapier MCP can publish to (see agent-runner's PLATFORM_CONFIG).
// `zapier` is kept as the generic/legacy option; `whatsapp` is the native
// (non-Zapier) connector.
const CONNECTOR_TYPES = [
  { value: 'zapier',              label: 'Zapier MCP (generic)', Icon: Zap },
  { value: 'zapier-mcp-linkedin', label: 'LinkedIn',   Icon: Linkedin },
  { value: 'zapier-mcp-x',        label: 'X (Twitter)', Icon: Twitter },
  { value: 'zapier-mcp-instagram', label: 'Instagram',  Icon: Instagram },
  { value: 'zapier-mcp-facebook', label: 'Facebook',    Icon: Facebook },
  { value: 'zapier-mcp-youtube',  label: 'YouTube',     Icon: Youtube },
  { value: 'zapier-mcp-tiktok',   label: 'TikTok',      Icon: Music2 },
  { value: 'zapier-mcp-threads',  label: 'Threads',     Icon: AtSign },
  { value: 'zapier-mcp-pinterest', label: 'Pinterest',  Icon: Pin },
  { value: 'zapier-mcp-telegram', label: 'Telegram',    Icon: Send },
  { value: 'zapier-mcp-google_calendar', label: 'Google Calendar', Icon: Calendar },
  { value: 'zapier-mcp-fresha',   label: 'Fresha',       Icon: Scissors },
  { value: 'whatsapp',            label: 'WhatsApp Business', Icon: MessageCircle },
];
function typeMeta(type: string) {
  return CONNECTOR_TYPES.find(t => t.value === type) ?? { value: type, label: type, Icon: Plug };
}

// Matches a Zapier-reported app display name ("LinkedIn", "Instagram for
// Business", "X (Twitter)") back to our internal zapier-mcp-<platform> type
// slug, so discovery can tell the user which of their enabled apps we
// actually support and pre-select it  instead of them guessing among 12
// dropdown options which one matches what they set up on zapier.com/mcp.
const APP_NAME_KEYWORDS: Array<{ type: string; keywords: string[] }> = [
  { type: 'zapier-mcp-linkedin', keywords: ['linkedin'] },
  { type: 'zapier-mcp-x', keywords: ['twitter', 'x (twitter)'] },
  { type: 'zapier-mcp-instagram', keywords: ['instagram'] },
  { type: 'zapier-mcp-facebook', keywords: ['facebook'] },
  { type: 'zapier-mcp-youtube', keywords: ['youtube'] },
  { type: 'zapier-mcp-tiktok', keywords: ['tiktok'] },
  { type: 'zapier-mcp-threads', keywords: ['threads'] },
  { type: 'zapier-mcp-pinterest', keywords: ['pinterest'] },
  { type: 'zapier-mcp-telegram', keywords: ['telegram'] },
  { type: 'zapier-mcp-google_calendar', keywords: ['google calendar'] },
  { type: 'zapier-mcp-fresha', keywords: ['fresha'] },
];
function matchAppToType(appName: string): string | null {
  const lower = appName.toLowerCase();
  return APP_NAME_KEYWORDS.find(({ keywords }) => keywords.some(k => lower.includes(k)))?.type ?? null;
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
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <PageHeader eyebrow="System" title="Connectors" action={
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white hover:opacity-90"
          style={{ background: 'var(--accent)' }}
        >
          <Plus className="w-4 h-4" /> New Connector
        </button>
      } />

      {loading && <Spinner />}
      {error && <div className="text-sm rounded-lg px-4 py-3" style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)' }}>{error}</div>}
      {!loading && !rows.length && (
        <EmptyState Icon={Plug} title="No connectors configured"
          hint="Connect a platform via Zapier MCP so your agents can publish content there directly."
          action={
            <button onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white hover:opacity-90"
              style={{ background: 'var(--accent)' }}>
              <Plus className="w-4 h-4" /> Connect a platform
            </button>
          } />
      )}
      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {rows.map((c: Connector) => {
            const meta = typeMeta(c.type);
            const statusCfg = STATUS_CFG[c.status ?? 'disconnected'] ?? STATUS_CFG.disconnected;
            const platforms = platformsForConnector(c);
            return (
            <Card key={c.id} hover className="p-5">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--accent-bg)' }}>
                    <meta.Icon className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate" style={{ color: 'var(--text)' }}>{c.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{meta.label} · via Zapier MCP</p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border shrink-0" style={{ borderColor: 'var(--border)', color: statusCfg.color }}>
                  <statusCfg.Icon className="w-3 h-3" /> {statusCfg.label}
                </span>
              </div>
              {platforms.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {platforms.map(p => {
                    const pm = platformMeta(p);
                    return (
                      <span key={p} className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent-bg)', color: 'var(--text)' }}>
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: pm.bar }} /> {pm.label}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs mb-3 px-2.5 py-1.5 rounded-lg" style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)' }}>
                  No platform mapped to this connector yet -- posts can't target it. Edit it and pick at least one platform.
                </p>
              )}
              <div className="flex gap-2 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                <button onClick={() => handleTest(c)} disabled={testingId === c.id}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border disabled:opacity-50" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
                  <RefreshCw className={`w-3 h-3 ${testingId === c.id ? 'animate-spin' : ''}`} /> {testingId === c.id ? 'Testing…' : 'Test'}
                </button>
                <button onClick={() => setEditingConnector(c)} className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
                  <Pencil className="w-3 h-3" /> Edit
                </button>
                <button onClick={() => setDeletingConnector(c)} className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border ml-auto" style={{ borderColor: 'var(--border)', color: '#dc2626' }}>
                  <Trash2 className="w-3 h-3" /> Remove
                </button>
              </div>
            </Card>
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

function ConnectorModal({ connector, onClose, onSave, loading }: {
  connector: Connector | null;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
  loading: boolean;
}) {
  const [name, setName] = useState(connector?.name ?? '');
  const [type, setType] = useState(connector?.type ?? 'zapier-mcp-linkedin');
  const [apiKey, setApiKey] = useState('');
  const [phone, setPhone] = useState(connector?.phone ?? '');
  // Which platforms this connector actually covers. One Zapier MCP token can
  // cover several at once (linkedin + facebook + youtube, say) -- this is
  // what posts.list()'s platform filter and the New Post platform dropdown
  // actually read (`platformsForConnector` in PostsPage.tsx), NOT `type`.
  // A narrow type (zapier-mcp-linkedin) always implies exactly one platform;
  // the generic `zapier` type needs this set explicitly via discovery below.
  const [platforms, setPlatforms] = useState<Set<string>>(new Set(connector?.platforms ?? []));

  const [discovering, setDiscovering] = useState(false);
  const [discoveredApps, setDiscoveredApps] = useState<string[] | null>(null);
  const [discoverError, setDiscoverError] = useState('');

  const isZapier = type === 'zapier' || type.startsWith('zapier-mcp');
  const isGeneric = type === 'zapier';

  async function handleDiscover() {
    if (!apiKey.trim()) return;
    setDiscovering(true);
    setDiscoverError('');
    setDiscoveredApps(null);
    try {
      const { apps } = await ecgApi.connectors.discover(apiKey.trim());
      setDiscoveredApps(apps);
      if (apps.length === 0) setDiscoverError('This token is valid but has no apps enabled yet. Add one at zapier.com/mcp.');
    } catch (e: any) {
      setDiscoverError(e?.message ?? 'Could not check this token.');
    } finally {
      setDiscovering(false);
    }
  }

  // Toggle a discovered app in/out of the platform set (multi-select -- one
  // token commonly covers several platforms at once). For a narrow single-
  // platform type, clicking still just re-confirms that one platform and can
  // switch `type` to match if it was left on a different narrow value.
  function toggleDiscoveredApp(appName: string) {
    const matched = matchAppToType(appName);
    if (!matched) return;
    const platformKey = matched.startsWith('zapier-mcp-') ? matched.replace('zapier-mcp-', '') : matched;
    setPlatforms(prev => {
      const next = new Set(prev);
      if (next.has(platformKey)) next.delete(platformKey); else next.add(platformKey);
      return next;
    });
    if (!isGeneric) setType(matched);
    if (!name.trim()) setName(appName);
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !type) return;
    // Narrow types (zapier-mcp-linkedin, whatsapp) always imply exactly one
    // platform even if discovery was never run for them; only the generic
    // `zapier` type relies entirely on the multi-select above.
    const resolvedPlatforms = isGeneric
      ? [...platforms]
      : (platforms.size > 0 ? [...platforms] : platformsForConnector({ type, platforms: [] }));
    const payload: Record<string, unknown> = { name: name.trim(), type, platforms: resolvedPlatforms };
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
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--accent-bg)]">
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
              className="w-full px-3 py-2 rounded-lg border focus:outline-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              autoFocus
            />
          </div>

          {isZapier && (
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Zapier MCP Token</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => { setApiKey(e.target.value); setDiscoveredApps(null); setDiscoverError(''); }}
                  placeholder={connector ? 'Leave blank to keep current token' : 'Paste your token from zapier.com/mcp'}
                  className="flex-1 min-w-0 px-3 py-2 rounded-lg border font-mono text-xs focus:outline-none"
                  style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
                />
                <button type="button" onClick={handleDiscover} disabled={!apiKey.trim() || discovering}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border shrink-0 disabled:opacity-50"
                  style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
                  <Search className={`w-3.5 h-3.5 ${discovering ? 'animate-spin' : ''}`} />
                  {discovering ? 'Checking…' : 'Check apps'}
                </button>
              </div>
              <p className="text-[11px] mt-1" style={{ color: 'var(--muted)' }}>
                "Check apps" tells you exactly which platforms this token can publish to  select every one this
                connector should cover (one token commonly covers several).
              </p>

              {discoverError && (
                <p className="text-xs mt-2 px-2.5 py-1.5 rounded-lg" style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)' }}>{discoverError}</p>
              )}

              {discoveredApps && discoveredApps.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  <p className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>Found on this token  tap each platform to include it:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {discoveredApps.map(app => {
                      const matched = matchAppToType(app);
                      const platformKey = matched?.startsWith('zapier-mcp-') ? matched.replace('zapier-mcp-', '') : matched;
                      const isSelected = !!platformKey && platforms.has(platformKey);
                      return (
                        <button key={app} type="button" onClick={() => toggleDiscoveredApp(app)}
                          className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border"
                          style={isSelected
                            ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }
                            : { borderColor: 'var(--border)', color: 'var(--text)' }}>
                          {matched ? <CheckCircle className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                          {app}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {isGeneric && platforms.size > 0 && (
                <p className="text-[11px] mt-2" style={{ color: 'var(--muted)' }}>
                  This connector will cover: {[...platforms].map(p => platformMeta(p).label).join(', ')}
                </p>
              )}
              {isGeneric && platforms.size === 0 && (
                <p className="text-[11px] mt-2" style={{ color: '#dc2626' }}>
                  Select at least one platform above  a generic connector with none picked won't show up anywhere posts can target it.
                </p>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Platform</label>
            <select
              value={type}
              onChange={e => setType(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              required
            >
              {CONNECTOR_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            {!isGeneric && discoveredApps && !discoveredApps.some(a => matchAppToType(a) === type) && (
              <p className="text-[11px] mt-1" style={{ color: '#dc2626' }}>
                This platform wasn't found on your token  saving now may not actually work.
              </p>
            )}
          </div>

          {type === 'whatsapp' && (
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Phone Number</label>
              <input
                type="text"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="+15551234567"
                className="w-full px-3 py-2 rounded-lg border font-mono text-xs focus:outline-none"
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
              className="flex-1 px-4 py-2 rounded-lg text-white hover:opacity-90 disabled:opacity-50"
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
            className="flex-1 px-4 py-2 rounded-lg text-white bg-red-600 hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
