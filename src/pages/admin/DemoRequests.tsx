import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

interface DemoRequest {
  id: string;
  email: string;
  company_name: string;
  message: string | null;
  status: string;
  admin_notes: string | null;
  org_id: string | null;
  created_at: string;
}

const STATUS_COLORS: Record<string, 'secondary' | 'default' | 'destructive'> = {
  pending: 'secondary',
  contacted: 'default',
  converted: 'default',
  declined: 'destructive',
};

export default function DemoRequests() {
  const [requests, setRequests] = useState<DemoRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<DemoRequest | null>(null);
  const [adminNotes, setAdminNotes] = useState('');
  const [convertOrgId, setConvertOrgId] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('demo_requests')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) toast.error('Failed to load demo requests');
    else setRequests((data as DemoRequest[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const openDetail = (req: DemoRequest) => {
    setSelected(req);
    setAdminNotes(req.admin_notes ?? '');
    setConvertOrgId('');
  };

  const updateStatus = async (id: string, status: string) => {
    const { error } = await supabase.from('demo_requests').update({ status }).eq('id', id);
    if (error) toast.error('Failed to update status');
    else {
      toast.success('Status updated');
      setRequests((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));
    }
  };

  const saveNotes = async () => {
    if (!selected) return;
    setSaving(true);
    const { error } = await supabase
      .from('demo_requests')
      .update({ admin_notes: adminNotes.trim() || null })
      .eq('id', selected.id);
    setSaving(false);
    if (error) toast.error('Failed to save notes');
    else {
      toast.success('Notes saved');
      setRequests((prev) =>
        prev.map((r) =>
          r.id === selected.id ? { ...r, admin_notes: adminNotes.trim() || null } : r
        )
      );
    }
  };

  const convertToAgency = async () => {
    if (!selected || !convertOrgId.trim()) {
      toast.error('Org ID is required');
      return;
    }
    setSaving(true);
    const { error } = await supabase.rpc('convert_demo_to_agency', {
      p_request_id: selected.id,
      p_org_id: convertOrgId.trim(),
    });
    setSaving(false);
    if (error) toast.error('Conversion failed: ' + error.message);
    else {
      toast.success('Converted to Agency!');
      setSelected(null);
      load();
    }
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Demo Requests</h1>
        <Button variant="outline" size="sm" onClick={load}>
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="animate-pulse h-40 bg-muted rounded" />
      ) : requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">No demo requests yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((req) => (
              <TableRow key={req.id}>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(req.created_at).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-sm">{req.email}</TableCell>
                <TableCell className="text-sm">{req.company_name}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_COLORS[req.status] ?? 'secondary'}>{req.status}</Badge>
                </TableCell>
                <TableCell className="text-right space-x-2">
                  {req.status === 'pending' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => updateStatus(req.id, 'contacted')}
                    >
                      Mark Contacted
                    </Button>
                  )}
                  <Button size="sm" onClick={() => openDetail(req)}>
                    Details
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        {selected && (
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {selected.company_name} — {selected.email}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              {selected.message && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Message</p>
                  <p className="text-sm">{selected.message}</p>
                </div>
              )}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Admin Notes</p>
                <Textarea
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  rows={3}
                  placeholder="Internal notes…"
                />
              </div>
              <div className="flex gap-2 flex-wrap">
                {['pending', 'contacted', 'converted', 'declined'].map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={selected.status === s ? 'default' : 'outline'}
                    onClick={() => updateStatus(selected.id, s)}
                  >
                    {s}
                  </Button>
                ))}
              </div>
              <div className="space-y-1 border-t pt-3">
                <p className="text-xs font-medium">Convert to Agency</p>
                <div className="flex gap-2">
                  <Input
                    value={convertOrgId}
                    onChange={(e) => setConvertOrgId(e.target.value)}
                    placeholder="Organisation UUID"
                  />
                  <Button size="sm" onClick={convertToAgency} disabled={saving}>
                    Convert
                  </Button>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button size="sm" onClick={saveNotes} disabled={saving}>
                {saving ? 'Saving…' : 'Save Notes'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
