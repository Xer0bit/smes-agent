import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ActivityType = 'idle' | 'thinking' | 'writing' | 'building' | 'error' | 'preview-ready';

export interface ProjectActivityProps {
    type: ActivityType;
    message: string;
    details?: string;
    className?: string;
}

export const ProjectActivityIndicator: React.FC<ProjectActivityProps> = ({
    type,
    message,
    className,
}) => {
    const [dots, setDots] = useState(1);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const isActive = ['thinking', 'writing', 'building'].includes(type);

    useEffect(() => {
        if (!isActive) { setDots(1); return; }
        timerRef.current = setInterval(() => setDots(d => (d % 3) + 1), 500);
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, [isActive]);

    if (type === 'idle' && !message) return null;

    const isComplete = type === 'preview-ready';
    const isError = type === 'error';

    return (
        <div className={cn(
            'flex items-center gap-2 text-[13px] px-1 transition-all duration-200',
            isComplete && 'text-emerald-400/80',
            isError    && 'text-rose-400/80',
            !isComplete && !isError && 'text-zinc-400',
            className
        )}>
            {isComplete ? (
                <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-emerald-400" />
            ) : isError ? (
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-rose-400" />
            ) : (
                <span className="flex gap-[3px] items-center flex-shrink-0">
                    {[1, 2, 3].map(n => (
                        <span
                            key={n}
                            className={cn(
                                'w-1 h-1 rounded-full transition-all duration-200',
                                n === dots ? 'bg-indigo-400 scale-125' : 'bg-zinc-600'
                            )}
                        />
                    ))}
                </span>
            )}
            <span className="truncate leading-none">{message}</span>
        </div>
    );
};
