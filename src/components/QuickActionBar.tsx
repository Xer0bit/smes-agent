/**
 * Quick Action Bar
 * One-click common prompts for faster development.
 */

import React from 'react';
import { Button } from '@/components/ui/button';
import {
    Layout,
    Palette,
    Smartphone,
    Moon,
    LogIn,
    Menu,
    Plus,
    Sparkles
} from 'lucide-react';

export interface QuickAction {
    id: string;
    label: string;
    prompt: string;
    icon: React.ReactNode;
    category: 'layout' | 'style' | 'feature';
}

const QUICK_ACTIONS: QuickAction[] = [
    {
        id: 'navbar',
        label: 'Add Navbar',
        prompt: 'Add a modern, responsive navigation bar with logo on the left, navigation links in the center, and a CTA button on the right. Make it sticky with a subtle backdrop blur.',
        icon: <Menu className="w-4 h-4" />,
        category: 'layout',
    },
    {
        id: 'footer',
        label: 'Add Footer',
        prompt: 'Add a professional footer with multiple columns for links, social media icons, and a copyright notice. Use a dark background with light text.',
        icon: <Layout className="w-4 h-4" />,
        category: 'layout',
    },
    {
        id: 'hero',
        label: 'Add Hero Section',
        prompt: 'Add an impressive hero section with a large headline, subheadline, and primary CTA button. Include a subtle gradient background or pattern.',
        icon: <Sparkles className="w-4 h-4" />,
        category: 'layout',
    },
    {
        id: 'responsive',
        label: 'Make Responsive',
        prompt: 'Make the entire application fully responsive. Ensure it looks great on mobile (375px), tablet (768px), and desktop (1280px+). Use a mobile-first approach.',
        icon: <Smartphone className="w-4 h-4" />,
        category: 'style',
    },
    {
        id: 'styling',
        label: 'Improve Styling',
        prompt: 'Improve the overall visual design with better spacing, modern colors (Indigo/Violet palette), subtle shadows, smooth hover transitions, and consistent border-radius.',
        icon: <Palette className="w-4 h-4" />,
        category: 'style',
    },
    {
        id: 'darkmode',
        label: 'Add Dark Mode',
        prompt: 'Add a dark mode toggle with proper color scheme. Use CSS variables for easy theming. Persist the preference in localStorage. Include smooth transition between modes.',
        icon: <Moon className="w-4 h-4" />,
        category: 'feature',
    },
    {
        id: 'login',
        label: 'Add Login',
        prompt: 'Add a login page with email and password fields, validation, error handling, loading state, and a submit button. Include "Forgot password" and "Sign up" links.',
        icon: <LogIn className="w-4 h-4" />,
        category: 'feature',
    },
    {
        id: 'component',
        label: 'New Component',
        prompt: 'Create a new reusable React component with proper TypeScript types, CSS styles, and accessibility features.',
        icon: <Plus className="w-4 h-4" />,
        category: 'layout',
    },
];

interface QuickActionBarProps {
    onAction: (prompt: string) => void;
    disabled?: boolean;
    compact?: boolean;
}

export const QuickActionBar: React.FC<QuickActionBarProps> = ({
    onAction,
    disabled = false,
    compact = false
}) => {
    return (
        <div className={`flex flex-wrap gap-2 ${compact ? 'justify-center' : ''}`}>
            {QUICK_ACTIONS.map((action) => (
                <Button
                    key={action.id}
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onAction(action.prompt)}
                    className="flex items-center gap-1.5 text-xs bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20 text-gray-300 hover:text-white transition-all"
                >
                    {action.icon}
                    {!compact && <span>{action.label}</span>}
                </Button>
            ))}
        </div>
    );
};

export default QuickActionBar;
