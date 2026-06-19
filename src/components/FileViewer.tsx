import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { FileTree } from "./FileTree";
import { CodeDisplay } from "./CodeDisplay";
import { toast } from "sonner";
import JSZip from "jszip";

interface FileViewerProps {
  files: Array<{ path: string; content: string }>;
  onPreview?: (file: { path: string; content: string }) => void;
}

export const FileViewer = ({ files, onPreview }: FileViewerProps) => {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const handleFileSelect = (path: string) => {
    setSelectedFile(path);
  };

  const handleDownloadFile = (file: { path: string; content: string }) => {
    try {
      const blob = new Blob([file.content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.path.split('/').pop() || 'file.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${file.path}`);
    } catch (err) {
      toast.error("Failed to download file");
    }
  };

  const handleDownloadAll = async () => {
    try {
      const zip = new JSZip();

      files.forEach((file) => {
        zip.file(file.path, file.content);
      });

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "source-code.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Downloaded all files as ZIP");
    } catch (err) {
      toast.error("Failed to create ZIP file");
    }
  };

  const currentFile = files.find((f) => f.path === selectedFile) || null;

  return (
    <div className="flex flex-col h-full bg-black">
      {/* Header */}
      <div className="px-6 py-3 border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Source Code</h2>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleDownloadAll}
            disabled={files.length === 0}
          >
            <Download className="h-4 w-4 mr-2" />
            Download All as ZIP
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* File Tree - Left Panel */}
        <div className="w-80 border-r border-zinc-800 bg-zinc-900">
          <FileTree
            files={files}
            selectedFile={selectedFile}
            onFileSelect={handleFileSelect}
          />
        </div>

        {/* Code Display - Right Panel */}
        <div className="flex-1 bg-black">
          <CodeDisplay
            file={currentFile}
            onDownload={handleDownloadFile}
            onPreview={onPreview}
          />
        </div>
      </div>
    </div>
  );
};
