import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeyRound, Plus, Trash2, Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";

interface SecretRow {
  id: string;
  key_name: string;
  key_preview: string; // last 4 chars only
  created_at: string;
}

interface SecretsSettingsProps {
  projectId?: string;
}

// Supabase-js throws plain PostgrestError objects ({message, code, details}),
// not native Error instances, so `err instanceof Error` never matches them
// and the real cause (RLS denial, missing table, etc.) got swallowed.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export function SecretsSettings({ projectId }: SecretsSettingsProps) {
  const queryClient = useQueryClient();
  const queryKey = ["project-secrets", projectId];
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: secrets = [], isLoading: loading } = useQuery({
    queryKey,
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('project_secrets')
        .select('id, key_name, key_preview, created_at')
        .eq('project_id', projectId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as SecretRow[];
    },
  });

  const handleAdd = async () => {
    const trimmedKey = newKey.trim().replace(/\s+/g, '_').toUpperCase();
    const trimmedValue = newValue.trim();
    if (!trimmedKey || !trimmedValue || !projectId) return;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(trimmedKey)) {
      toast.error('Key must be uppercase letters, digits, and underscores only.');
      return;
    }
    if (secrets.some(s => s.key_name === trimmedKey)) {
      toast.error(`Secret "${trimmedKey}" already exists.`);
      return;
    }
    setSaving(true);
    try {
      const preview = trimmedValue.length > 4 ? `****${trimmedValue.slice(-4)}` : '****';
      const { error } = await supabase
        .from('project_secrets')
        .insert({ project_id: projectId, key_name: trimmedKey, key_value: trimmedValue, key_preview: preview });
      if (error) throw error;
      toast.success(`Secret "${trimmedKey}" saved.`);
      setNewKey('');
      setNewValue('');
      setAdding(false);
      queryClient.invalidateQueries({ queryKey });
    } catch (err: unknown) {
      const msg = extractErrorMessage(err, 'Failed to save secret');
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, keyName: string) => {
    setDeletingId(id);
    try {
      const { error } = await supabase.from('project_secrets').delete().eq('id', id);
      if (error) throw error;
      toast.success(`Secret "${keyName}" deleted.`);
      queryClient.setQueryData(queryKey, (prev: SecretRow[] | undefined) => (prev ?? []).filter(s => s.id !== id));
    } catch (err: unknown) {
      const msg = extractErrorMessage(err, 'Failed to delete secret');
      toast.error(msg);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white/85 mb-1">Secrets</h2>
        <p className="text-sm text-white/45">
          Store API keys and sensitive values per project. Values are masked after saving.
        </p>
      </div>

      <Card className="bg-[#0f0f12] border-white/[0.07]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-primary" />
            Project Secrets
          </CardTitle>
          <CardDescription>
            Secrets are stored securely and only accessible to your project.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="space-y-2 py-1">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : secrets.length === 0 && !adding ? (
            <p className="text-sm text-white/45 py-2">No secrets yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {secrets.map(secret => (
                <div key={secret.id} className="flex items-center justify-between py-2.5 gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-mono font-medium truncate">{secret.key_name}</p>
                    <p className="text-xs text-white/45 font-mono">{secret.key_preview}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={deletingId === secret.id}
                    onClick={() => handleDelete(secret.id, secret.key_name)}
                    className="shrink-0 text-destructive hover:text-destructive"
                  >
                    {deletingId === secret.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {adding ? (
            <div className="space-y-3 pt-2 border-t border-white/[0.07]">
              <div className="space-y-1">
                <Label className="text-xs">Key name</Label>
                <Input
                  placeholder="MY_API_KEY"
                  value={newKey}
                  onChange={e => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                  className="font-mono text-sm h-8"
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Value</Label>
                <div className="relative">
                  <Input
                    type={showValue ? 'text' : 'password'}
                    placeholder="sk-..."
                    value={newValue}
                    onChange={e => setNewValue(e.target.value)}
                    className="font-mono text-sm h-8 pr-8"
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false); }}
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-white/45 hover:text-white/85"
                    onClick={() => setShowValue(v => !v)}
                  >
                    {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAdd} disabled={!newKey || !newValue || saving} className="h-8">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setNewKey(''); setNewValue(''); }} className="h-8">
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-8"
              onClick={() => setAdding(true)}
            >
              <Plus className="h-3.5 w-3.5" /> Add Secret
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
