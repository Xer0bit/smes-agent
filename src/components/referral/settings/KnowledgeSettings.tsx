import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { BookOpen, Save, Loader2, Info, RotateCcw } from "lucide-react";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

interface KnowledgeSettingsProps {
    projectId?: string;
}

// ── Paywall ────────────────────────────────────────────────────────────────────

function PaywallCard() {
    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-white/85 mb-1">Knowledge</h2>
                <p className="text-sm text-white/45">
                    Configure AI prompt context and knowledge for your project
                </p>
            </div>
            <Card className="bg-[#0f0f12] border-indigo-500/30">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        Knowledge Configuration — Paid Plan Feature
                    </CardTitle>
                    <CardDescription>
                        Upgrade your organization plan to customise how the AI understands and works with your project.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Button
                        onClick={() => window.open('/dashboard/settings?section=workspace-plans', '_self')}
                        className="w-full"
                    >
                        Manage Billing
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}

// ── Main ────────────────────────────────────────────────────────────────────────

export const KnowledgeSettings = ({ projectId }: KnowledgeSettingsProps) => {
    const { subscribed } = useSubscription();

    const [systemPrompt, setSystemPrompt] = useState('');
    const [contextNotes, setContextNotes] = useState('');
    const [original, setOriginal] = useState({ systemPrompt: '', contextNotes: '' });
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    // ── Load ─────────────────────────────────────────────────────────────────────
    const load = useCallback(async () => {
        if (!projectId) return;
        setLoading(true);
        const { data, error } = await supabase
            .from('projects')
            .select('custom_system_prompt, context_notes')
            .eq('id', projectId)
            .single();

        if (error) {
            toast.error('Failed to load knowledge settings');
        } else if (data) {
            const sp = (data as { custom_system_prompt?: string; context_notes?: string }).custom_system_prompt ?? '';
            const cn = (data as { custom_system_prompt?: string; context_notes?: string }).context_notes ?? '';
            setSystemPrompt(sp);
            setContextNotes(cn);
            setOriginal({ systemPrompt: sp, contextNotes: cn });
        }
        setLoading(false);
    }, [projectId]);

    useEffect(() => { load(); }, [load]);

    // ── Save ──────────────────────────────────────────────────────────────────────
    const handleSave = async () => {
        if (!projectId) return;
        setSaving(true);
        try {
            const { error } = await supabase
                .from('projects')
                .update({
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    custom_system_prompt: systemPrompt.trim() || null as any,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    context_notes: contextNotes.trim() || null as any,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', projectId);

            if (error) throw error;
            setOriginal({ systemPrompt: systemPrompt.trim(), contextNotes: contextNotes.trim() });
            toast.success('Knowledge configuration saved');
        } catch (err) {
            toast.error((err as Error).message || 'Failed to save knowledge configuration');
        } finally {
            setSaving(false);
        }
    };

    const handleReset = () => {
        setSystemPrompt(original.systemPrompt);
        setContextNotes(original.contextNotes);
    };

    const isDirty = systemPrompt !== original.systemPrompt || contextNotes !== original.contextNotes;

    if (!subscribed) return <PaywallCard />;

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-white/85 mb-1">Knowledge</h2>
                <p className="text-sm text-white/45">
                    Configure AI prompt context and knowledge for your project
                </p>
            </div>

            {/* Info banner */}
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300">
                <Info className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                <span>
                    These settings are injected into the App Builder's system prompt on every generation.
                    Use them to tailor the AI to your project's tech stack, tone, and conventions.
                </span>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin text-white/45" />
                </div>
            ) : (
                <>
                    {/* System Prompt */}
                    <Card className="bg-[#0f0f12] border-white/[0.07]">
                        <CardHeader>
                            <CardTitle className="text-base flex items-center gap-2">
                                <BookOpen className="h-4 w-4" />
                                Custom System Prompt
                            </CardTitle>
                            <CardDescription className="text-xs">
                                Injected at the top of every App Builder prompt. Define rules, conventions,
                                and constraints specific to your project.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            <Label htmlFor="system-prompt" className="text-xs text-white/45">
                                Instructions (max 3000 chars)
                            </Label>
                            <Textarea
                                id="system-prompt"
                                value={systemPrompt}
                                onChange={e => setSystemPrompt(e.target.value.slice(0, 3000))}
                                placeholder={
                                    'e.g. This is a Hong Kong e-commerce site targeting Cantonese-speaking users.\n' +
                                    'Always add bilingual labels (English + 繁中) to form buttons.\n' +
                                    'Use HKD currency formatting — never USD.\n' +
                                    'Payment provider: Stripe (already integrated — do not add a second provider).'
                                }
                                rows={8}
                                className="text-sm font-mono resize-y"
                            />
                            <p className="text-[11px] text-white/45 text-right tabular-nums">
                                {systemPrompt.length}/3000
                            </p>
                        </CardContent>
                    </Card>

                    {/* Context Notes */}
                    <Card className="bg-[#0f0f12] border-white/[0.07]">
                        <CardHeader>
                            <CardTitle className="text-base flex items-center gap-2">
                                <BookOpen className="h-4 w-4" />
                                Project Context Notes
                            </CardTitle>
                            <CardDescription className="text-xs">
                                Background knowledge the AI uses when generating code — describe your domain,
                                data model, integrations, and brand.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            <Label htmlFor="context-notes" className="text-xs text-white/45">
                                Context (max 2000 chars)
                            </Label>
                            <Textarea
                                id="context-notes"
                                value={contextNotes}
                                onChange={e => setContextNotes(e.target.value.slice(0, 2000))}
                                placeholder={
                                    'e.g. Tech stack: React 18 + Supabase + Stripe.\n' +
                                    'Brand: blue (#1877F2) and white. Font: Inter.\n' +
                                    'Target market: HK retail — products are sold in HKD.\n' +
                                    'Main entities: Product, Order, Customer, Vendor.\n' +
                                    'Auth is already set up — do not rebuild it.'
                                }
                                rows={6}
                                className="text-sm font-mono resize-y"
                            />
                            <p className="text-[11px] text-white/45 text-right tabular-nums">
                                {contextNotes.length}/2000
                            </p>
                        </CardContent>
                    </Card>

                    {/* Actions */}
                    <div className="flex gap-3">
                        {isDirty && (
                            <Button variant="ghost" onClick={handleReset} className="gap-2">
                                <RotateCcw className="h-4 w-4" />
                                Reset
                            </Button>
                        )}
                        <Button
                            onClick={handleSave}
                            disabled={saving || !isDirty}
                            className="flex-1 gap-2"
                        >
                            {saving
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Save className="h-4 w-4" />
                            }
                            {saving ? 'Saving…' : 'Save Knowledge Configuration'}
                        </Button>
                    </div>
                </>
            )}
        </div>
    );
};
