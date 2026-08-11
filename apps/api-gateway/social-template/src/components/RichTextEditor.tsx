import { Textarea } from "@/components/ui/textarea";

interface RichTextEditorProps {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
  clientId?: string;
}

// Plain-text editor. This was a tiptap-based WYSIWYG (bold/italic/headings/
// images/links) in the original import, but @tiptap/* isn't in
// preview-service's pre-baked package set -- every preview using it failed
// to build ("Cannot find module '@tiptap/react'"). Rich text editing here
// would need preview-service's shared dependency image rebuilt to add
// tiptap; a plain textarea works everywhere with zero new dependencies.
// Callers (PressReleases.tsx) already render saved content through
// dangerouslySetInnerHTML, so plain text (no tags) still displays exactly
// as typed -- this is a real feature reduction (no bold/links/images), not
// a silent breakage.
export function RichTextEditor({ content, onChange, placeholder = "Write your content…", clientId: _clientId }: RichTextEditorProps) {
  return (
    <Textarea
      value={content}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={10}
      className="min-h-[200px] font-body"
    />
  );
}
