import { useEffect, useState } from 'react';
import { Settings, Users, Key, Receipt, Plus, Trash2, X, Mail, Shield } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';

const TABS = [
  { id: 'org', label: 'Organization', icon: Settings },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'api-keys', label: 'API Keys', icon: Key },
  { id: 'billing', label: 'Billing', icon: Receipt },
] as const;
type Tab = typeof TABS[number]['id'];

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('org');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Org data
  const [org, setOrg] = useState<any>(null);
  const [savingOrg, setSavingOrg] = useState(false);

  // Team data
  const [team, setTeam] = useState<any[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [deletingUser, setDeletingUser] = useState<any>(null);

  // API Keys data
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const [revokingKey, setRevokingKey] = useState<any>(null);
  const [newKey, setNewKey] = useState<any>(null);

  // Billing data
  const [invoices, setInvoices] = useState<any[]>([]);

  useEffect(() => {
    Promise.all([
      ecgApi.org.get(),
      ecgApi.team.list(),
      ecgApi.apiKeys.list(),
      ecgApi.billing.invoices(),
    ])
      .then(([orgData, teamData, keysData, invoicesData]) => {
        setOrg(orgData);
        setTeam(Array.isArray(teamData) ? teamData : []);
        setApiKeys(Array.isArray(keysData) ? keysData : []);
        setInvoices(Array.isArray(invoicesData) ? invoicesData : (invoicesData.invoices ?? []));
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSaveOrg = async (updates: any) => {
    setSavingOrg(true);
    try {
      const updated = await ecgApi.org.update(updates);
      setOrg({ ...org, ...updated });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingOrg(false);
    }
  };

  const handleInvite = async (email: string, name: string) => {
    setInviting(true);
    try {
      const created = await ecgApi.team.create({ email, name });
      setTeam([...team, created]);
      setShowInvite(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setInviting(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!deletingUser?.id) return;
    setInviting(true);
    try {
      await ecgApi.team.delete(deletingUser.id);
      setTeam(team.filter(u => u.id !== deletingUser.id));
      setDeletingUser(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setInviting(false);
    }
  };

  const handleCreateKey = async (name: string) => {
    setCreatingKey(true);
    try {
      const created = await ecgApi.apiKeys.create({ name });
      setApiKeys([...apiKeys, { ...created, fullKey: created.key }]);
      setNewKey(created);
      setShowCreateKey(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreatingKey(false);
    }
  };

  const handleRevokeKey = async () => {
    if (!revokingKey?.id) return;
    setCreatingKey(true);
    try {
      await ecgApi.apiKeys.revoke(revokingKey.id);
      setApiKeys(apiKeys.map(k => k.id === revokingKey.id ? { ...k, status: 'revoked' } : k));
      setRevokingKey(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreatingKey(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Settings</h1>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl w-full overflow-x-auto" style={{ background: 'var(--border)' }}>
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
              style={tab === t.id ? { background: 'var(--card-bg)', color: 'var(--text)' } : { color: 'var(--muted)' }}>
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {loading && <Spinner />}
      {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{error}</div>}

      {/* Org Tab */}
      {!loading && tab === 'org' && org && (
        <OrgSettings org={org} onSave={handleSaveOrg} saving={savingOrg} />
      )}

      {/* Team Tab */}
      {!loading && tab === 'team' && (
        <TeamSettings
          team={team}
          onInvite={handleInvite}
          onDelete={handleDeleteUser}
          inviting={inviting}
          deletingUser={deletingUser}
          setDeletingUser={setDeletingUser}
          showInvite={showInvite}
          setShowInvite={setShowInvite}
        />
      )}

      {/* API Keys Tab */}
      {!loading && tab === 'api-keys' && (
        <ApiKeysSettings
          apiKeys={apiKeys}
          onCreate={handleCreateKey}
          onRevoke={handleRevokeKey}
          creating={creatingKey}
          revokingKey={revokingKey}
          setRevokingKey={setRevokingKey}
          showCreate={showCreateKey}
          setShowCreate={setShowCreateKey}
          newKey={newKey}
          setNewKey={setNewKey}
        />
      )}

      {/* Billing Tab */}
      {!loading && tab === 'billing' && <BillingSettings invoices={invoices} />}
    </div>
  );
}

function Spinner() {
  return <div className="flex justify-center py-16"><span className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>;
}

function OrgSettings({ org, onSave, saving }: { org: any; onSave: (data: any) => void; saving: boolean }) {
  const [name, setName] = useState(org.name ?? '');
  const [country, setCountry] = useState(org.country ?? '');
  const [timezone, setTimezone] = useState(org.timezone ?? '');
  const [billingEmail, setBillingEmail] = useState(org.billingEmail ?? org.billing_email ?? '');
  const [billingAddress, setBillingAddress] = useState(org.billingAddress ?? org.billing_address ?? '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ name, country, timezone, billingEmail, billingAddress });
  };

  return (
    <div className="rounded-xl border p-6 space-y-4" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
      <h2 className="text-md font-semibold" style={{ color: 'var(--text)' }}>Organization Profile</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Country</label>
            <input
              type="text"
              value={country}
              onChange={e => setCountry(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Timezone</label>
            <input
              type="text"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              placeholder="Australia/Sydney"
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Billing Email</label>
            <input
              type="email"
              value={billingEmail}
              onChange={e => setBillingEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Billing Address</label>
          <textarea
            value={billingAddress}
            onChange={e => setBillingAddress(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2 resize-none"
            style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
          />
        </div>
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

function TeamSettings({ team, onInvite, onDelete, inviting, deletingUser, setDeletingUser, showInvite, setShowInvite }: {
  team: any[];
  onInvite: (email: string, name: string) => void;
  onDelete: () => void;
  inviting: boolean;
  deletingUser: any;
  setDeletingUser: (user: any) => void;
  showInvite: boolean;
  setShowInvite: (show: boolean) => void;
}) {
  return (
    <div className="rounded-xl border p-6 space-y-4" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
      <div className="flex items-center justify-between">
        <h2 className="text-md font-semibold" style={{ color: 'var(--text)' }}>Team Members</h2>
        <button
          onClick={() => setShowInvite(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
          style={{ background: 'var(--accent)' }}
        >
          <Plus className="w-4 h-4" /> Invite
        </button>
      </div>

      {!team.length ? (
        <div className="text-center py-8 text-sm" style={{ color: 'var(--muted)' }}>No team members yet</div>
      ) : (
        <div className="space-y-2">
          {team.map((u: any) => (
            <div key={u.id} className="flex items-center justify-between p-3 rounded-lg border" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium" style={{ background: 'var(--border)', color: 'var(--text)' }}>
                  {u.name?.charAt(0)?.toUpperCase() ?? u.email?.charAt(0)?.toUpperCase() ?? '?'}
                </div>
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>{u.name}</p>
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>{u.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-1 rounded-full bg-purple-100 text-purple-700 capitalize">{u.role}</span>
                <button
                  onClick={() => setDeletingUser(u)}
                  className="p-1 rounded hover:bg-red-50"
                  title="Remove"
                >
                  <Trash2 className="w-4 h-4 text-red-600" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onInvite={onInvite}
          loading={inviting}
        />
      )}

      {deletingUser && (
        <DeleteConfirmModal
          itemName={deletingUser.name}
          onClose={() => setDeletingUser(null)}
          onConfirm={onDelete}
          loading={inviting}
        />
      )}
    </div>
  );
}

function ApiKeysSettings({ apiKeys, onCreate, onRevoke, creating, revokingKey, setRevokingKey, showCreate, setShowCreate, newKey, setNewKey }: {
  apiKeys: any[];
  onCreate: (name: string) => void;
  onRevoke: () => void;
  creating: boolean;
  revokingKey: any;
  setRevokingKey: (key: any) => void;
  showCreate: boolean;
  setShowCreate: (show: boolean) => void;
  newKey: any;
  setNewKey: (key: any) => void;
}) {
  return (
    <div className="rounded-xl border p-6 space-y-4" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
      <div className="flex items-center justify-between">
        <h2 className="text-md font-semibold" style={{ color: 'var(--text)' }}>API Keys</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
          style={{ background: 'var(--accent)' }}
        >
          <Plus className="w-4 h-4" /> New Key
        </button>
      </div>

      {!apiKeys.length ? (
        <div className="text-center py-8 text-sm" style={{ color: 'var(--muted)' }}>No API keys yet</div>
      ) : (
        <div className="space-y-2">
          {apiKeys.map((k: any) => (
            <div key={k.id} className="flex items-center justify-between p-3 rounded-lg border" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-3">
                <Key className="w-4 h-4" style={{ color: 'var(--muted)' }} />
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>{k.name}</p>
                  <p className="text-xs font-mono" style={{ color: 'var(--muted)' }}>{k.keyPrefix ?? k.prefix ?? k.key_prefix}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-1 rounded-full capitalize ${k.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                  {k.status ?? 'active'}
                </span>
                {(k.status === 'active' || !k.status) && (
                  <button
                    onClick={() => setRevokingKey(k)}
                    className="p-1 rounded hover:bg-red-50"
                    title="Revoke"
                  >
                    <Trash2 className="w-4 h-4 text-red-600" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateKeyModal
          onClose={() => setShowCreate(false)}
          onCreate={onCreate}
          loading={creating}
        />
      )}

      {revokingKey && (
        <DeleteConfirmModal
          itemName={`API key "${revokingKey.name}"`}
          onClose={() => setRevokingKey(null)}
          onConfirm={onRevoke}
          loading={creating}
        />
      )}

      {newKey && (
        <NewKeyModal
          keyData={newKey}
          onClose={() => setNewKey(null)}
        />
      )}
    </div>
  );
}

function BillingSettings({ invoices }: { invoices: any[] }) {
  return (
    <div className="rounded-xl border p-6 space-y-4" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
      <h2 className="text-md font-semibold" style={{ color: 'var(--text)' }}>Billing History</h2>
      {!invoices.length ? (
        <div className="text-center py-8 text-sm" style={{ color: 'var(--muted)' }}>No invoices yet</div>
      ) : (
        <div className="space-y-2">
          {invoices.map((inv: any) => (
            <div key={inv.id} className="flex items-center justify-between p-3 rounded-lg border" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-3">
                <Receipt className="w-4 h-4" style={{ color: 'var(--muted)' }} />
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>Invoice #{inv.number ?? inv.id?.slice(0, 8)}</p>
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>{new Date(inv.date ?? inv.created_at).toLocaleDateString()}</p>
                </div>
              </div>
              <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                ${(inv.amount / 100).toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InviteModal({ onClose, onInvite, loading }: {
  onClose: () => void;
  onInvite: (email: string, name: string) => void;
  loading: boolean;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !name.trim()) return;
    onInvite(email.trim(), name.trim());
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Invite Team Member</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
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
              disabled={loading || !email.trim() || !name.trim()}
              className="flex-1 px-4 py-2 rounded-lg text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              {loading ? 'Inviting...' : 'Send Invite'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CreateKeyModal({ onClose, onCreate, loading }: {
  onClose: () => void;
  onCreate: (name: string) => void;
  loading: boolean;
}) {
  const [name, setName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate(name.trim());
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Create API Key</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Key Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., Production API"
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              autoFocus
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
              {loading ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function NewKeyModal({ keyData, onClose }: { keyData: any; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <div className="flex items-center gap-3">
          <Shield className="w-8 h-8 text-green-600" />
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>API Key Created</h2>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>Copy this key now — you won't see it again</p>
          </div>
        </div>

        <div className="p-3 rounded-lg bg-gray-100 border">
          <code className="text-sm font-mono break-all" style={{ color: 'var(--text)' }}>{keyData.fullKey ?? keyData.key}</code>
        </div>

        <button
          onClick={onClose}
          className="w-full px-4 py-2 rounded-lg text-white font-medium"
          style={{ background: 'var(--accent)' }}
        >
          I've Copied It
        </button>
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
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Confirm Deletion</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Are you sure you want to remove <strong>{itemName}</strong>? This action cannot be undone.
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
