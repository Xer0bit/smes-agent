import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface ReferralReward {
  id: string;
  referee_id: string;
  lines_earned: number;
  awarded_at: string;
}

export interface ReferralState {
  referralCode: string | null;
  bonusLines: number;
  rewards: ReferralReward[];
  loading: boolean;
  referralLink: string;
}

export function useReferral(): ReferralState {
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [bonusLines, setBonusLines] = useState(0);
  const [rewards, setRewards] = useState<ReferralReward[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (userId === null) return;
    if (!userId) { setLoading(false); return; }

    Promise.all([
      // Get or create referral code via RPC (referral_code lives on `referrals` table, not profiles)
      supabase.rpc('get_or_create_referral_code', { p_user_id: userId }) as any,
      // bonus_publish_lines is the correct column on profiles
      supabase
        .from('profiles')
        .select('bonus_publish_lines')
        .eq('id', userId)
        .single(),
      supabase
        .from('referral_rewards')
        .select('id, referee_id, lines_earned, awarded_at')
        .eq('referrer_id', userId)
        .order('awarded_at', { ascending: false }),
    ]).then(([codeRes, profileRes, rewardsRes]) => {
      if (codeRes.data) {
        setReferralCode(codeRes.data as string);
      }
      if (profileRes.data) {
        setBonusLines((profileRes.data as any).bonus_publish_lines ?? 0);
      }
      if (rewardsRes.data) {
        setRewards(rewardsRes.data as ReferralReward[]);
      }
      setLoading(false);
    });
  }, [userId]);

  const referralLink = referralCode
    ? `${window.location.origin}/register?ref=${referralCode}`
    : '';

  return { referralCode, bonusLines, rewards, loading, referralLink };
}
