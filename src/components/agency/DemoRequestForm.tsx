import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';

interface DemoRequestFormProps {
  orgId?: string;
  onSuccess?: () => void;
}

export function DemoRequestForm({ orgId, onSuccess }: DemoRequestFormProps) {
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email.trim() || !companyName.trim()) {
      toast.error('Email and company name are required');
      return;
    }

    setLoading(true);
    const { error } = await supabase.rpc('submit_demo_request', {
      p_email: email.trim(),
      p_company_name: companyName.trim(),
      p_message: message.trim() || null,
      p_org_id: orgId ?? null,
    });
    setLoading(false);

    if (error) {
      toast.error('Failed to submit demo request');
    } else {
      toast.success("Demo request submitted! We'll be in touch soon.");
      setEmail('');
      setCompanyName('');
      setMessage('');
      onSuccess?.();
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="demo-email">Email</Label>
        <Input
          id="demo-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="demo-company">Company Name</Label>
        <Input
          id="demo-company"
          type="text"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          placeholder="Acme Inc."
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="demo-message">Message (optional)</Label>
        <Textarea
          id="demo-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Tell us about your needs…"
          rows={3}
        />
      </div>
      <Button onClick={submit} disabled={loading} className="w-full">
        {loading ? 'Submitting…' : 'Request a Demo'}
      </Button>
    </div>
  );
}
