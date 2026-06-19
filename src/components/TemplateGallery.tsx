/**
 * Template Gallery
 * UI component for browsing and selecting project templates.
 */

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { PREMIUM_TEMPLATES, ProjectTemplate } from '@/templates/premiumTemplates';
import { Layout, BarChart3, ShoppingBag, FileText, Briefcase, X } from 'lucide-react';

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
    landing: <Layout className="w-5 h-5" />,
    dashboard: <BarChart3 className="w-5 h-5" />,
    ecommerce: <ShoppingBag className="w-5 h-5" />,
    blog: <FileText className="w-5 h-5" />,
    portfolio: <Briefcase className="w-5 h-5" />,
};

const CATEGORIES = [
    { id: 'all', label: 'All Templates' },
    { id: 'landing', label: 'Landing Pages' },
    { id: 'dashboard', label: 'Dashboards' },
    { id: 'ecommerce', label: 'E-commerce' },
    { id: 'blog', label: 'Blogs' },
    { id: 'portfolio', label: 'Portfolios' },
];

interface TemplateGalleryProps {
    onSelect: (template: ProjectTemplate) => void;
    onClose?: () => void;
}

export const TemplateGallery: React.FC<TemplateGalleryProps> = ({
    onSelect,
    onClose
}) => {
    const [selectedCategory, setSelectedCategory] = useState('all');
    const [hoveredTemplate, setHoveredTemplate] = useState<string | null>(null);

    const filteredTemplates = selectedCategory === 'all'
        ? PREMIUM_TEMPLATES
        : PREMIUM_TEMPLATES.filter(t => t.category === selectedCategory);

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-gray-900 rounded-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
                    <div>
                        <h2 className="text-xl font-semibold text-white">Template Gallery</h2>
                        <p className="text-sm text-gray-400">Choose a template to start your project</p>
                    </div>
                    {onClose && (
                        <Button variant="ghost" size="sm" onClick={onClose} className="text-gray-400 hover:text-white">
                            <X className="w-5 h-5" />
                        </Button>
                    )}
                </div>

                {/* Category Tabs */}
                <div className="flex gap-2 px-6 py-3 border-b border-white/5 overflow-x-auto">
                    {CATEGORIES.map(cat => (
                        <Button
                            key={cat.id}
                            variant={selectedCategory === cat.id ? 'default' : 'ghost'}
                            size="sm"
                            onClick={() => setSelectedCategory(cat.id)}
                            className={`flex items-center gap-2 whitespace-nowrap ${selectedCategory === cat.id
                                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                                }`}
                        >
                            {cat.id !== 'all' && CATEGORY_ICONS[cat.id]}
                            {cat.label}
                        </Button>
                    ))}
                </div>

                {/* Templates Grid */}
                <div className="flex-1 overflow-y-auto p-6">
                    {filteredTemplates.length === 0 ? (
                        <div className="text-center py-12 text-gray-500">
                            <p>No templates in this category yet.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {filteredTemplates.map(template => (
                                <div
                                    key={template.id}
                                    className="group relative bg-gray-800/50 rounded-xl overflow-hidden border border-white/5 hover:border-indigo-500/50 transition-all cursor-pointer"
                                    onMouseEnter={() => setHoveredTemplate(template.id)}
                                    onMouseLeave={() => setHoveredTemplate(null)}
                                    onClick={() => onSelect(template)}
                                >
                                    {/* Thumbnail */}
                                    <div className="aspect-video bg-gradient-to-br from-indigo-600/20 to-violet-600/20 flex items-center justify-center">
                                        <div className="text-6xl opacity-30">
                                            {CATEGORY_ICONS[template.category]}
                                        </div>
                                    </div>

                                    {/* Info */}
                                    <div className="p-4">
                                        <h3 className="font-semibold text-white mb-1">{template.name}</h3>
                                        <p className="text-sm text-gray-400 mb-3">{template.description}</p>
                                        <div className="flex flex-wrap gap-1">
                                            {template.tags.slice(0, 3).map(tag => (
                                                <span
                                                    key={tag}
                                                    className="px-2 py-0.5 bg-white/5 rounded text-xs text-gray-400"
                                                >
                                                    {tag}
                                                </span>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Hover Overlay */}
                                    {hoveredTemplate === template.id && (
                                        <div className="absolute inset-0 bg-indigo-600/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Button className="bg-white text-indigo-600 hover:bg-gray-100">
                                                Use Template
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-white/5 flex justify-between items-center">
                    <p className="text-sm text-gray-500">
                        {filteredTemplates.length} template{filteredTemplates.length !== 1 ? 's' : ''} available
                    </p>
                    <Button variant="outline" size="sm" onClick={onClose} className="border-white/10 text-gray-400 hover:text-white">
                        Start from Scratch
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default TemplateGallery;
