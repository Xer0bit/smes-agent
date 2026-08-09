import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowUp, Paperclip, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface HeroProps {
  onCreateProject: (prompt: string, fileContext?: string) => Promise<void>;
  isProcessing?: boolean;
}

export const Hero = ({ onCreateProject, isProcessing = false }: HeroProps) => {
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isLocalProcessing, setIsLocalProcessing] = useState(false);

  const submitting = isProcessing || isLocalProcessing;

  const validateFiles = (fileList: FileList): boolean => {
    if (files.length + fileList.length > 10) {
      toast.error("Maximum 10 files allowed");
      return false;
    }
    for (let i = 0; i < fileList.length; i++) {
      if (fileList[i].size > 20 * 1024 * 1024) {
        toast.error(`File ${fileList[i].name} exceeds 20MB limit`);
        return false;
      }
    }
    return true;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && validateFiles(e.target.files)) {
      setFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
    }
  };

  const handleSubmit = async () => {
    if (!prompt.trim()) return;

    setIsLocalProcessing(true);
    let fileContext = "";

    try {
      if (files.length > 0) {
        fileContext = " [Files processed]";
      }
      await onCreateProject(prompt, fileContext);
    } catch {
      toast.error("Failed to create project");
    } finally {
      setIsLocalProcessing(false);
    }
  };

  return (
    <section className="relative min-h-[calc(100vh-64px)] overflow-hidden bg-[#0b1422] px-4 pb-20 pt-20 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(115%_70%_at_50%_0%,rgba(8,20,36,0.96)_18%,rgba(23,67,112,0.82)_42%,rgba(13,153,199,0.74)_67%,rgba(54, 111, 218, 0.72)_92%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(35%_22%_at_85%_88%,rgba(34,211,238,0.22),transparent_76%)]" />
        <motion.div
          className="absolute inset-x-0 top-0 h-[56%] bg-[#081321]/76"
          animate={{ opacity: [0.74, 0.8, 0.74] }}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      <div className="relative mx-auto flex min-h-[72vh] max-w-5xl flex-col items-center justify-center text-center">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          className="mb-12 inline-flex items-center gap-2 rounded-full border border-cyan-300/25 bg-[#12324f]/65 px-4 py-1.5 text-xs font-medium text-cyan-100 backdrop-blur"
        >
          <span className="rounded-full bg-cyan-400 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#072030]">
            New
          </span>
          Building beyond apps
          <span className="text-cyan-200/80">→</span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.05, ease: "easeOut" }}
          className="w-full max-w-2xl"
        >
          <div className="rounded-[24px] border border-cyan-200/20 bg-[#111a28]/86 p-3 shadow-[0_24px_64px_rgba(3,20,35,0.62)] backdrop-blur-xl">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="Ask eCOMGear to build your ecommerce flow..."
              className="h-[66px] w-full resize-none bg-transparent px-3 py-2 text-[15px] text-white placeholder:text-cyan-100/55 outline-none"
            />

            <div className="mt-1 flex items-center justify-between px-1">
              <div className="flex items-center gap-1">
                <input
                  type="file"
                  id="landing-file-upload"
                  multiple
                  className="hidden"
                  onChange={handleFileChange}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => document.getElementById("landing-file-upload")?.click()}
                  className="h-8 w-8 rounded-full text-cyan-100/80 hover:bg-cyan-300/10 hover:text-cyan-100"
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => document.getElementById("landing-file-upload")?.click()}
                  className="h-8 w-8 rounded-full text-cyan-100/80 hover:bg-cyan-300/10 hover:text-cyan-100"
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                {files.length > 0 && (
                  <span className="ml-1 text-[11px] text-cyan-100/75">
                    {files.length} file{files.length > 1 ? "s" : ""}
                  </span>
                )}
              </div>

              <Button
                onClick={handleSubmit}
                disabled={!prompt.trim() || submitting}
                className="h-8 w-8 rounded-full bg-cyan-400 p-0 text-[#062030] hover:bg-cyan-300 disabled:opacity-50"
              >
                {submitting ? (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-900/25 border-t-slate-900" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
};
