import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowUp } from "lucide-react";
import { toast } from "sonner";

interface FooterCTAProps {
    onCreateProject: (prompt: string, fileContext?: string) => Promise<void>;
    isProcessing?: boolean;
}

export const FooterCTA = ({ onCreateProject, isProcessing = false }: FooterCTAProps) => {
    const [prompt, setPrompt] = useState("");
    const [isFocused, setIsFocused] = useState(false);

    const handleSubmit = async () => {
        if (!prompt.trim()) return;
        try {
            await onCreateProject(prompt);
        } catch {
            toast.error('Failed to create project from CTA');
        }
    };

    return (
        <section className="w-full border-t border-white/10 bg-[#0b1220] py-20 text-white">
            <div className="mx-auto max-w-4xl px-6 text-center lg:px-10">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-300">Launch your next build</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                    Start your first draft now
                </h2>
                <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-slate-300">
                    One prompt, a real working baseline, and fast iteration from there.
                </p>

                <div className="relative mx-auto mt-8 w-full max-w-2xl">
                    <div className={`relative flex w-full flex-col rounded-2xl border bg-[#10192d] ${isFocused ? 'border-cyan-400/50' : 'border-white/10'} shadow-xl transition-all duration-300`}>
                    <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onFocus={() => setIsFocused(true)}
                        onBlur={() => setIsFocused(false)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                handleSubmit();
                            }
                        }}
                        placeholder="Example: Build a conversion-focused category page with smart filters and merchandising slots."
                        className="min-h-[110px] w-full resize-none bg-transparent px-4 py-4 text-[15px] text-white placeholder:text-slate-500 outline-none"
                    />
                    <div className="flex items-center justify-between border-t border-white/10 p-2">
                        <div className="flex items-center gap-2 pl-2 text-[11px] font-medium text-slate-400">
                            <span>Business-focused generation</span>
                        </div>
                        <Button
                            onClick={handleSubmit}
                            disabled={!prompt.trim() || isProcessing}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400 p-0 text-slate-950 transition-all hover:bg-cyan-300 disabled:opacity-50 disabled:bg-white/20 disabled:text-white/40"
                        >
                            {isProcessing ? (
                                <span className="w-3 h-3 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                            ) : (
                                <ArrowUp className="w-3.5 h-3.5" />
                            )}
                        </Button>
                    </div>
                </div>
            </div>
            </div>
        </section>
    );
};
