import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface QuotaLimitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resetAt?: string | null;
  onUpgrade?: () => void;
  onAutoRetry?: () => Promise<boolean>;
}

function formatExactDateTime(resetAt?: string | null): string {
  if (!resetAt) return 'Unknown reset time';
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return 'Unknown reset time';
  return date.toLocaleString();
}

function formatCountdownMs(targetMs: number): string {
  if (targetMs <= 0) return 'now';

  const totalSeconds = Math.floor(targetMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function QuotaLimitDialog({
  open,
  onOpenChange,
  resetAt,
  onUpgrade,
  onAutoRetry,
}: QuotaLimitDialogProps) {
  const [now, setNow] = useState(Date.now());
  const [isAutoRetrying, setIsAutoRetrying] = useState(false);
  const [didAutoRetry, setDidAutoRetry] = useState(false);

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setDidAutoRetry(false);
      setIsAutoRetrying(false);
      return;
    }
    setDidAutoRetry(false);
  }, [open, resetAt]);

  const resetTime = useMemo(() => {
    if (!resetAt) return null;
    const value = new Date(resetAt).getTime();
    return Number.isNaN(value) ? null : value;
  }, [resetAt]);

  const countdownText = useMemo(() => {
    if (!resetTime) return 'Unavailable';
    return formatCountdownMs(resetTime - now);
  }, [now, resetTime]);

  const exactTimeText = useMemo(() => formatExactDateTime(resetAt), [resetAt]);

  useEffect(() => {
    if (!open) return;
    if (!resetTime) return;
    if (!onAutoRetry) return;
    if (didAutoRetry || isAutoRetrying) return;
    if (resetTime - now > 0) return;

    let cancelled = false;
    setDidAutoRetry(true);
    setIsAutoRetrying(true);

    onAutoRetry()
      .then((allowed) => {
        if (!cancelled && allowed) {
          onOpenChange(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsAutoRetrying(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, resetTime, now, onAutoRetry, didAutoRetry, isAutoRetrying, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-[#0f1117] border-white/10 text-zinc-100">
        <DialogHeader>
          <DialogTitle>Eco Quota Reached</DialogTitle>
          <DialogDescription className="text-zinc-400">
            You have used all your available eco for this 24h window.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-1.5">
          <p className="text-xs text-zinc-400 uppercase tracking-wide">Next Reset</p>
          <p className="text-sm text-zinc-100 font-medium">{exactTimeText}</p>
          <p className="text-xs text-zinc-400">
            Countdown: {countdownText}
            {isAutoRetrying ? ' • Checking quota...' : ''}
          </p>
        </div>

        <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
          <Button
            type="button"
            variant="secondary"
            className="bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
            onClick={() => onOpenChange(false)}
          >
            Wait until reset ({countdownText})
          </Button>
          <Button
            type="button"
            className="bg-indigo-600 hover:bg-indigo-500 text-white"
            onClick={() => {
              onUpgrade?.();
            }}
          >
            Upgrade plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
