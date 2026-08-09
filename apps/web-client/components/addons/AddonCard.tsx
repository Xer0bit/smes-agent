import { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Lock } from 'lucide-react';

interface AddonCardProps {
  title: string;
  description: string;
  price?: string;
  active: boolean;
  loading?: boolean;
  requiresTier?: 'pro' | 'agency';
  currentTier?: string | null;
  onActivate?: () => void;
  onDeactivate?: () => void;
  children?: ReactNode;
}

export function AddonCard({
  title,
  description,
  price,
  active,
  loading = false,
  requiresTier,
  currentTier,
  onActivate,
  onDeactivate,
  children,
}: AddonCardProps) {
  const tierRank = { free: 0, pro: 1, agency: 2 } as Record<string, number>;
  const requiredRank = requiresTier ? (tierRank[requiresTier] ?? 0) : 0;
  const currentRank = currentTier ? (tierRank[currentTier] ?? 0) : 0;
  const tierBlocked = requiresTier != null && currentRank < requiredRank;

  return (
    <Card className={tierBlocked ? 'opacity-60' : ''}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
          <div className="flex items-center gap-1 shrink-0">
            {price && <Badge variant="outline">{price}</Badge>}
            {active && <Badge className="bg-green-500 text-white">Active</Badge>}
            {tierBlocked && (
              <Badge variant="secondary" className="flex items-center gap-1">
                <Lock className="w-3 h-3" />
                {requiresTier}
              </Badge>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!tierBlocked && (
          <div className="flex gap-2">
            {!active && onActivate && (
              <Button size="sm" onClick={onActivate} disabled={loading}>
                {loading ? 'Activating…' : 'Activate'}
              </Button>
            )}
            {active && onDeactivate && (
              <Button size="sm" variant="outline" onClick={onDeactivate} disabled={loading}>
                {loading ? 'Deactivating…' : 'Deactivate'}
              </Button>
            )}
          </div>
        )}
        {tierBlocked && (
          <p className="text-xs text-muted-foreground">
            Upgrade to <strong>{requiresTier}</strong> to unlock this add-on.
          </p>
        )}
        {active && !tierBlocked && children}
      </CardContent>
    </Card>
  );
}
