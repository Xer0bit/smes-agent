/**
 * ChangeTracker — Realtime file change visualization during prompt execution.
 * Lovable-inspired sliding panel showing files being written/modified/deleted
 * with live diff stats, timestamps, and animation.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  FilePlus,
  FileEdit,
  FileX,
  FileCode,
  ChevronDown,
  ChevronUp,
  Clock,
  CheckCircle2,
  Loader2,
  Eye,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';

export interface TrackedChange {
  id: string;
  path: string;
  action: 'create' | 'modify' | 'delete';
  timestamp: number;
  status: 'pending' | 'writing' | 'complete';
  stats?: { additions: number; deletions: number };
  content?: string;
}

interface ChangeTrackerProps {
  changes: TrackedChange[];
  isActive: boolean; // true while AI is working
  onViewFile?: (path: string, content?: string) => void;
  onDismiss?: () => void;
  className?: string;
}

/** Splits a path into dirPrefix + filename for display */
function splitPath(path: string): { dir: string; name: string } {
  const parts = path.split('/');
  const name = parts.pop() ?? path;
  const dir = parts.length > 0 ? parts.join('/') + '/' : '';
  return { dir, name };
}

export const ChangeTracker: React.FC<ChangeTrackerProps> = ({
  changes,
  isActive,
  onViewFile,
  onDismiss,
  className,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest change
  useEffect(() => {
    if (scrollRef.current && isExpanded) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [changes, isExpanded]);

  if (changes.length === 0 && !isActive) return null;

  const completedCount = changes.filter(c => c.status === 'complete').length;
  const totalAdditions = changes.reduce((sum, c) => sum + (c.stats?.additions || 0), 0);
  const totalDeletions = changes.reduce((sum, c) => sum + (c.stats?.deletions || 0), 0);

  const getActionIcon = (action: string, status: string) => {
    if (status === 'writing') return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />;
    switch (action) {
      case 'create': return <FilePlus className="h-3.5 w-3.5 text-emerald-400" />;
      case 'modify': return <FileEdit className="h-3.5 w-3.5 text-amber-400" />;
      case 'delete': return <FileX className="h-3.5 w-3.5 text-rose-400" />;
      default: return <FileCode className="h-3.5 w-3.5 text-zinc-400" />;
    }
  };

  const getActionLabel = (action: string) => {
    switch (action) {
      case 'create': return 'Created';
      case 'modify': return 'Modified';
      case 'delete': return 'Deleted';
      default: return action;
    }
  };

  const formatTimestamp = (ts: number) => {
    const diff = Date.now() - ts;
    if (diff < 1000) return 'now';
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    return `${Math.floor(diff / 60000)}m ago`;
  };

  return (
    <div className={cn(
      'border border-white/[0.06] rounded-lg bg-[#111113] overflow-hidden transition-all duration-300',
      isActive && 'ring-1 ring-blue-500/20',
      className
    )}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 cursor-pointer select-none hover:bg-white/[0.02] transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2.5">
          {isActive ? (
            <div className="relative">
              <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
            </div>
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          )}
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-[12px] font-medium text-white/90 flex-shrink-0">
              {isActive ? 'Writing' : `${changes.length} file${changes.length !== 1 ? 's' : ''} changed`}
            </span>
            {isActive && changes.length > 0 && (() => {
              const latest = changes[changes.length - 1];
              const { dir, name } = splitPath(latest.path);
              return (
                <span className="text-[11px] font-mono truncate">
                  <span className="text-zinc-500">{dir}</span>
                  <span className="text-blue-300 font-medium">{name}</span>
                </span>
              );
            })()}
          </div>
          {changes.length > 0 && (
            <span className="text-[10px] text-zinc-500">
              {completedCount}/{changes.length}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Aggregate stats */}
          {(totalAdditions > 0 || totalDeletions > 0) && (
            <div className="flex items-center gap-1.5 text-[10px] font-mono">
              <span className="text-emerald-400">+{totalAdditions}</span>
              <span className="text-zinc-600">/</span>
              <span className="text-rose-400">-{totalDeletions}</span>
            </div>
          )}
          {isExpanded ? (
            <ChevronUp className="h-3.5 w-3.5 text-zinc-500" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
          )}
        </div>
      </div>

      {/* Progress bar */}
      {isActive && changes.length > 0 && (
        <div className="h-[2px] bg-zinc-800">
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-500"
            style={{ width: `${(completedCount / changes.length) * 100}%` }}
          />
        </div>
      )}

      {/* File list */}
      {isExpanded && (
        <div ref={scrollRef} className="max-h-[168px] overflow-y-auto">
          <div className="px-2 py-1 space-y-0.5">
            {changes.map((change, idx) => (
              <div
                key={change.id}
                className={cn(
                  'group flex items-center gap-2 px-2 py-1.5 rounded-md transition-all duration-200',
                  change.status === 'writing' && 'bg-blue-500/[0.06] border border-blue-500/10',
                  change.status === 'complete' && 'hover:bg-white/[0.03]',
                  change.status === 'pending' && 'opacity-50',
                  // Slide-in animation
                  'animate-in fade-in slide-in-from-left-2'
                )}
                style={{ animationDelay: `${idx * 50}ms` }}
              >
                {/* Icon */}
                <div className="flex-shrink-0">
                  {getActionIcon(change.action, change.status)}
                </div>

                {/* File path */}
                <div className="flex-1 min-w-0">
                  {(() => {
                    const { dir, name } = splitPath(change.path);
                    return (
                      <div className="flex items-baseline gap-0 font-mono leading-tight min-w-0">
                        <span className="text-[10px] text-zinc-600 truncate flex-shrink min-w-0 max-w-[35%]">{dir}</span>
                        <span className="text-[11px] text-zinc-200 font-medium truncate flex-shrink-0">{name}</span>
                      </div>
                    );
                  })()}
                  {change.status === 'writing' && (
                    <span className="text-[10px] text-blue-400/70 animate-pulse">Writing...</span>
                  )}
                </div>

                {/* Stats */}
                {change.stats && change.status === 'complete' && (
                  <div className="flex items-center gap-1 text-[10px] font-mono flex-shrink-0">
                    <span className="text-emerald-400/80">+{change.stats.additions}</span>
                    <span className="text-zinc-700">/</span>
                    <span className="text-rose-400/80">-{change.stats.deletions}</span>
                  </div>
                )}

                {/* Action badge */}
                <span className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded-md flex-shrink-0',
                  change.action === 'create' && 'bg-emerald-500/10 text-emerald-400',
                  change.action === 'modify' && 'bg-amber-500/10 text-amber-400',
                  change.action === 'delete' && 'bg-rose-500/10 text-rose-400',
                )}>
                  {getActionLabel(change.action)}
                </span>

                {/* View button */}
                {onViewFile && change.status === 'complete' && change.action !== 'delete' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-zinc-500 hover:text-white"
                    onClick={(e) => {
                      e.stopPropagation();
                      onViewFile(change.path, change.content);
                    }}
                  >
                    <Eye className="h-3 w-3" />
                  </Button>
                )}

                {/* Timestamp */}
                <span className="hidden sm:inline text-[10px] text-zinc-600 flex-shrink-0 tabular-nums">
                  {formatTimestamp(change.timestamp)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ChangeTracker;
