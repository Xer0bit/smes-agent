import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { DesignTemplate, TemplateQuestion } from '@/data/designTemplates';

interface Props {
  template: DesignTemplate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (template: DesignTemplate, answers: Record<string, string>) => void;
}

export const TemplateQuestionnaire = ({ template, open, onOpenChange, onSubmit }: Props) => {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  // Pre-fill defaults when dialog opens with a new template
  useEffect(() => {
    if (open && template) {
      const defaults: Record<string, string> = {};
      for (const q of template.questions) {
        if (q.defaultValue) defaults[q.id] = q.defaultValue;
      }
      setAnswers(defaults);
    }
    if (!open) setAnswers({});
  }, [open, template]);

  const handleSubmit = () => {
    if (!template) return;
    onSubmit(template, answers);
    setAnswers({});
  };

  if (!template) return null;

  const allAnswered = template.questions.some((q) => answers[q.id]?.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] bg-[#111] border-[#222] text-white">
        <DialogHeader>
          <DialogTitle className="text-lg font-medium">
            Customise your <span className="text-[#D6FF00]">{template.name}</span> site
          </DialogTitle>
          <DialogDescription className="text-sm text-white/50">
            Answer a few questions so the AI builds exactly what you need.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 mt-2">
          {template.questions.map((q: TemplateQuestion) => (
            <div key={q.id} className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-white/80">{q.label}</label>
              <input
                type="text"
                placeholder={q.placeholder}
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-[#D6FF00]/50"
              />
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm text-white/60 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!allAnswered}
            className="px-5 py-2 text-sm font-medium rounded-md bg-[#D6FF00] text-[#0A0B0D] hover:bg-[#c5ee00] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Build site →
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
