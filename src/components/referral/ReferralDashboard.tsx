import { useState } from 'react';
import { useReferral } from '@/hooks/useReferral';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Copy, Gift, Users } from 'lucide-react';

export function ReferralDashboard() {
  const { referralCode, bonusLines, rewards, loading, referralLink } = useReferral();
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    if (!referralLink) return;
    await navigator.clipboard.writeText(referralLink);
    setCopied(true);
    toast.success('Referral link copied!');
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return <div className="animate-pulse h-32 bg-muted rounded-lg" />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gift className="w-4 h-4" />
            Your Referral Link
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 p-2 bg-muted rounded font-mono text-sm break-all">
            <span className="flex-1">{referralLink ?? '—'}</span>
            <Button size="sm" variant="outline" onClick={copyLink} disabled={!referralLink}>
              <Copy className="w-3 h-3 mr-1" />
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          {bonusLines > 0 && (
            <p className="text-sm text-muted-foreground">
              You have <strong>{bonusLines}</strong> bonus publish lines from referrals.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="w-4 h-4" />
            Referral History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rewards.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No referrals yet. Share your link to earn bonus publish lines!
            </p>
          ) : (
            <ul className="space-y-2">
              {rewards.map((r) => (
                <li key={r.id} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {new Date(r.awarded_at).toLocaleDateString()}
                  </span>
                  <Badge variant="secondary">+{r.lines_earned} lines</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
