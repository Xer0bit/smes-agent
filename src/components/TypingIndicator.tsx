/**
 * Typing Indicator
 * Animated dots to show AI is thinking.
 */

import React from 'react';
import { Bot } from 'lucide-react';

interface TypingIndicatorProps {
    message?: string;
}

export const TypingIndicator: React.FC<TypingIndicatorProps> = ({
    message = 'AI is thinking...'
}) => {
    return (
        <div className="flex gap-3">
            {/* Avatar */}
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center">
                <Bot className="w-4 h-4 text-white" />
            </div>

            {/* Typing Bubble */}
            <div className="flex-1">
                <div className="inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl rounded-tl-md bg-gray-800/80 border border-white/5">
                    <div className="flex gap-1">
                        <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                    <span className="text-sm text-gray-400">{message}</span>
                </div>
            </div>
        </div>
    );
};

export default TypingIndicator;
