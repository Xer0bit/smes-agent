import React, { useRef, useEffect } from 'react';
import { X, Trash2, Terminal as TerminalIcon, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

export interface TerminalLog {
    id: string;
    type: 'info' | 'error' | 'warn' | 'success';
    message: string;
    timestamp: number;
    source?: string; // e.g., 'system', 'build', 'runtime'
    meta?: {
        filePath?: string;
        line?: number;
        column?: number;
        raw?: string;
    };
}

interface TerminalPanelProps {
    isOpen: boolean;
    onClose: () => void;
    logs: TerminalLog[];
    onClear: () => void;
    onFix?: (log: TerminalLog) => void;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
    isOpen,
    onClose,
    logs,
    onClear,
    onFix
}) => {
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom on new logs
    useEffect(() => {
        if (isOpen && scrollRef.current) {
            const scrollElement = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
            if (scrollElement) {
                scrollElement.scrollTop = scrollElement.scrollHeight;
            }
        }
    }, [logs, isOpen]);

    if (!isOpen) return null;

    return (
        <div className="absolute bottom-12 left-0 right-0 h-64 bg-[#1e1e1e] border-t border-white/10 shadow-xl flex flex-col z-50 animate-in slide-in-from-bottom-5">
            {/* Header */}
            <div className="h-9 flex items-center justify-between px-4 bg-[#252526] border-b border-white/5 select-none">
                <div className="flex items-center gap-2 text-xs font-medium text-gray-400">
                    <TerminalIcon className="w-3.5 h-3.5" />
                    <span>TERMINAL</span>
                    <span className="bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded text-[10px]">
                        {logs.length} events
                    </span>
                </div>
                <div className="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-gray-400 hover:text-white hover:bg-white/10"
                        onClick={onClear}
                        title="Clear Terminal"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-gray-400 hover:text-white hover:bg-white/10"
                        onClick={onClose}
                        title="Close Terminal"
                    >
                        <X className="w-3.5 h-3.5" />
                    </Button>
                </div>
            </div>

            {/* Content */}
            <ScrollArea className="flex-1 w-full" ref={scrollRef}>
                <div className="p-2 font-mono text-xs">
                    {logs.length === 0 ? (
                        <div className="text-gray-600 italic p-4 text-center">
                            No output to display
                        </div>
                    ) : (
                        logs.map((log) => (
                            <div
                                key={log.id}
                                className={cn(
                                    "py-1 px-2 border-b border-white/5 hover:bg-white/5 flex items-start gap-2 break-all",
                                    log.type === 'error' ? "text-red-400 bg-red-500/5" :
                                        log.type === 'warn' ? "text-yellow-400" :
                                            log.type === 'success' ? "text-green-400" :
                                                "text-gray-300"
                                )}
                            >
                                <span className="flex-shrink-0 mt-0.5 opacity-70">
                                    {log.type === 'error' && <AlertCircle className="w-3 h-3" />}
                                    {log.type === 'warn' && <AlertTriangle className="w-3 h-3" />}
                                    {log.type === 'info' && <Info className="w-3 h-3" />}
                                    {log.type === 'success' && <Info className="w-3 h-3" />}
                                </span>
                                <div className="flex-1">
                                    <span className="opacity-50 mr-2 select-none">
                                        {new Date(log.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                    </span>
                                    {log.source && (
                                        <span className="opacity-50 mr-2 font-bold uppercase text-[10px]">
                                            [{log.source}]
                                        </span>
                                    )}
                                    <span>{log.message}</span>
                                </div>
                                {onFix && log.type === 'error' && log.meta?.filePath && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 px-2 text-[10px] text-red-200 hover:text-white hover:bg-red-500/20"
                                        onClick={() => onFix(log)}
                                        title="Fix with AI"
                                    >
                                        Fix
                                    </Button>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </ScrollArea>
        </div>
    );
};
