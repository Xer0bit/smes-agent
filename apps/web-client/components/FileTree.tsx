import { useState } from "react";
import { ChevronRight, ChevronDown, Search, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: FileNode[];
}

interface FileTreeProps {
  files: Array<{ path: string; content: string | null }>;
  selectedFile: string | null;
  onFileSelect: (path: string) => void;
}

// One muted color for every file type, matching the editor's own dark theme
// and the rest of this panel's white/opacity palette   no per-extension
// rainbow. Selected-row state still gets its own accent (see isSelected below).
const FILE_ICON_COLOR = 'text-white/35';

function FileIcon() {
  return (
    <span className={cn("inline-flex flex-shrink-0", FILE_ICON_COLOR)} style={{ width: 12, height: 12 }}>
      <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <rect x="1.5" y="0.5" width="7" height="9" rx="0.75" stroke="currentColor" strokeWidth="1" fill="none"/>
        <path d="M7 0.5v2.5h2.5" stroke="currentColor" strokeWidth="1" fill="none"/>
      </svg>
    </span>
  );
}

export const FileTree = ({ files, selectedFile, onFileSelect }: FileTreeProps) => {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(['src', 'src/components', 'src/pages'])
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  const buildTree = (files: Array<{ path: string; content: string }>): FileNode => {
    const root: FileNode = { name: 'root', path: '', type: 'folder', children: [] };
    files.forEach((file) => {
      const parts = file.path.split('/');
      let current = root;
      parts.forEach((part, index) => {
        const isFile = index === parts.length - 1;
        const currentPath = parts.slice(0, index + 1).join('/');
        if (!current.children) current.children = [];
        let child = current.children.find((c) => c.name === part);
        if (!child) {
          child = {
            name: part,
            path: currentPath,
            type: isFile ? 'file' : 'folder',
            children: isFile ? undefined : [],
          };
          current.children.push(child);
        }
        if (!isFile) current = child;
      });
    });
    const sortNodes = (nodes: FileNode[]) => {
      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      nodes.forEach((node) => { if (node.children) sortNodes(node.children); });
    };
    if (root.children) sortNodes(root.children);
    return root;
  };

  const toggleFolder = (path: string) => {
    const next = new Set(expandedFolders);
    next.has(path) ? next.delete(path) : next.add(path);
    setExpandedFolders(next);
  };

  const filteredFiles = searchQuery
    ? files.filter((f) => f.path.toLowerCase().includes(searchQuery.toLowerCase()))
    : files;

  const tree = buildTree(filteredFiles);

  const renderNode = (node: FileNode, level: number = 0): JSX.Element | null => {
    if (node.name === 'root') {
      return <>{node.children?.map((child) => renderNode(child, level))}</>;
    }

    const isExpanded = expandedFolders.has(node.path);
    const isSelected = selectedFile === node.path;
    const indent = level * 10 + 8;

    if (node.type === 'folder') {
      return (
        <div key={node.path}>
          <div
            className={cn(
              "flex items-center gap-[3px] h-[22px] cursor-pointer select-none text-[12.5px]",
              "text-white/70 hover:text-white/90 hover:bg-white/[0.04]",
              isSelected && "bg-white/[0.07] text-white/90"
            )}
            style={{ paddingLeft: `${indent}px` }}
            onClick={() => toggleFolder(node.path)}
            title={node.name}
          >
            {isExpanded
              ? <ChevronDown className="w-[10px] h-[10px] flex-shrink-0 opacity-60" />
              : <ChevronRight className="w-[10px] h-[10px] flex-shrink-0 opacity-60" />
            }
            <span className="ml-0.5 truncate min-w-0">{node.name}</span>
          </div>
          {isExpanded && node.children && (
            <div>{node.children.map((child) => renderNode(child, level + 1))}</div>
          )}
        </div>
      );
    }

    return (
      <div
        key={node.path}
        className={cn(
          "flex items-center gap-[5px] h-[22px] cursor-pointer select-none text-[12.5px]",
          "text-white/70 hover:text-white/90 hover:bg-white/[0.04]",
          isSelected && "bg-cyan-500/10 text-white/95 hover:bg-cyan-500/10"
        )}
        style={{ paddingLeft: `${indent + 14}px` }}
        onClick={() => onFileSelect(node.path)}
        title={node.path}
      >
        <FileIcon />
        <span className="truncate min-w-0">{node.name}</span>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-[#0b0b0d]">
      {/* Compact header row */}
      <div className="flex items-center justify-between px-2.5 h-[26px] border-b border-white/[0.04] flex-shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-white/40">Files</span>
        <button
          onClick={() => { setShowSearch(s => !s); if (showSearch) setSearchQuery(''); }}
          className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
        >
          {showSearch ? <X className="w-[10px] h-[10px]" /> : <Search className="w-[10px] h-[10px]" />}
        </button>
      </div>

      {showSearch && (
        <div className="px-2 py-1 flex-shrink-0 border-b border-white/[0.04]">
          <input
            autoFocus
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Filter…"
            className="w-full h-[22px] px-2 text-[11.5px] bg-white/5 border border-white/10 rounded text-white/85 placeholder-white/30 outline-none focus:border-white/20 font-mono"
          />
        </div>
      )}

      <ScrollArea className="flex-1 min-h-0">
        <div className="py-0.5">
          {filteredFiles.length === 0 ? (
            <div className="px-4 py-3 text-[11px] text-white/35">No files match.</div>
          ) : (
            renderNode(tree)
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
