import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Copy, Share2, Gift } from 'lucide-react';

interface ReferralReward {
  id: string;
  lines_earned: number;
  awarded_at: string;
}

export function ReferralContent() {
  const [referralCode, setReferralCode] = useState<string>('');
  const [bonusLines, setBonusLines] = useState(0);
  const [rewards, setRewards] = useState<ReferralReward[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadReferralData();
  }, []);

  const loadReferralData = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) return;

      // Get referral code via RPC (referral_code lives on referrals table, not profiles)
      const { data: codeData, error: codeError } = await supabase
        .rpc('get_or_create_referral_code', { p_user_id: userId }) as any;

      if (codeError) throw codeError;
      setReferralCode(codeData || '');

      // Read bonus_publish_lines from profiles (new schema)
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('bonus_publish_lines')
        .eq('id', userId)
        .single();

      if (profileError) throw profileError;
      setBonusLines(profile?.bonus_publish_lines || 0);

      // Load referral rewards history
      const { data: rewardData, error: rewardError } = await supabase
        .from('referral_rewards')
        .select('id, lines_earned, awarded_at')
        .eq('referrer_id', userId)
        .order('awarded_at', { ascending: false });

      if (rewardError) throw rewardError;
      setRewards((rewardData as ReferralReward[]) || []);
    } catch (error) {
      console.error('Error loading referral data:', error);
      toast.error('Failed to load referral data');
    } finally {
      setLoading(false);
    }
  };

  const copyReferralLink = () => {
    const link = `${window.location.origin}?ref=${referralCode}`;
    navigator.clipboard.writeText(link);
    toast.success('Referral link copied!');
  };

  const shareReferral = async () => {
    const link = `${window.location.origin}?ref=${referralCode}`;
    const text = `Join eComGear and get started with AI-powered web building! Use my referral link: ${link}`;

    if (navigator.share) {
      try {
        await navigator.share({ title: 'Join eComGear', text, url: link });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          copyReferralLink();
        }
      }
    } else {
      copyReferralLink();
    }
  };

  if (loading) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-2">Referral Program</h2>
        <p className="text-white/45">
          Earn bonus publish lines for each friend who registers and publishes their first site.
        </p>
      </div>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gift className="h-5 w-5 text-primary" />
            Your Referral Stats
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 bg-white/[0.04] rounded-lg">
              <div className="text-sm text-white/45">Total Referrals</div>
              <div className="text-2xl font-bold">{rewards.length}</div>
            </div>
            <div className="p-4 bg-white/[0.04] rounded-lg">
              <div className="text-sm text-white/45">Bonus Lines Earned</div>
              <div className="text-2xl font-bold text-primary">{bonusLines}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-workspace-surface border-white/[0.07]">
        <CardHeader>
          <CardTitle>Your Referral Link</CardTitle>
          <CardDescription>Share this link to invite friends</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={`${window.location.origin}?ref=${referralCode}`}
              readOnly
              className="font-mono text-sm"
            />
            <Button onClick={copyReferralLink} variant="outline" size="icon">
              <Copy className="h-4 w-4" />
            </Button>
            <Button onClick={shareReferral} variant="outline" size="icon">
              <Share2 className="h-4 w-4" />
            </Button>
          </div>
          {referralCode && (
            <p className="text-xs text-white/45">
              Your referral code: <span className="font-mono font-semibold">{referralCode}</span>
            </p>
          )}
        </CardContent>
      </Card>

      {rewards.length > 0 && (
        <Card className="bg-workspace-surface border-white/[0.07]">
          <CardHeader>
            <CardTitle>Referral History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {rewards.map((reward) => (
                <div
                  key={reward.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div className="text-sm text-white/45">
                    {new Date(reward.awarded_at).toLocaleDateString()}
                  </div>
                  <span className="text-sm font-semibold text-primary">
                    +{reward.lines_earned} lines
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
