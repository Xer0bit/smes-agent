import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Copy, Download, Check, Eye } from "lucide-react";
import { toast } from "sonner";

interface CodeDisplayProps {
  file: { path: string; content: string } | null;
  onDownload: (file: { path: string; content: string }) => void;
  onPreview?: (file: { path: string; content: string }) => void;
}

export const CodeDisplay = ({ file, onDownload, onPreview }: CodeDisplayProps) => {
  const [copied, setCopied] = useState(false);

  const isPreviewable = (path: string) => {
    return path.toLowerCase().endsWith('.html');
  };

  const handleCopy = async () => {
    if (!file) return;
    
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      toast.success("Code copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error("Failed to copy code");
    }
  };

  if (!file) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        Select a file to view its source code
      </div>
    );
  }

  const lines = file.content.split('\n');

  return (
    <div className="flex flex-col h-full bg-black">
      {/* Header with file path and actions */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900">
        <div className="text-sm font-mono text-zinc-300 truncate">
          {file.path}
        </div>
        <div className="flex gap-2">
          {isPreviewable(file.path) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPreview?.(file)}
              className="h-8 text-zinc-300 hover:text-white hover:bg-zinc-800"
            >
              <Eye className="h-4 w-4" />
              <span className="ml-2">Preview</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="h-8 text-zinc-300 hover:text-white hover:bg-zinc-800"
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            <span className="ml-2">Copy</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDownload(file)}
            className="h-8 text-zinc-300 hover:text-white hover:bg-zinc-800"
          >
            <Download className="h-4 w-4" />
            <span className="ml-2">Download</span>
          </Button>
        </div>
      </div>

      {/* Code display with line numbers */}
      <ScrollArea className="flex-1">
        <div className="flex">
          {/* Line numbers */}
          <div className="flex flex-col py-4 px-4 text-right text-zinc-600 text-xs font-mono select-none border-r border-zinc-800 bg-zinc-950">
            {lines.map((_, i) => (
              <div key={i} className="leading-6">
                {i + 1}
              </div>
            ))}
          </div>

          {/* Code content */}
          <pre className="flex-1 py-4 px-4 text-xs font-mono leading-6 overflow-x-auto bg-black">
            <code className="text-zinc-100">{file.content}</code>
          </pre>
        </div>
      </ScrollArea>
    </div>
  );
};
