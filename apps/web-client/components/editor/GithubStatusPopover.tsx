import { Github, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

interface GithubStatusPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connected: boolean;
  login?: string;
  link?: { fullName: string; branch: string } | null;
  onOpenSettings: (section: string) => void;
}

export function GithubStatusPopover({ open, onOpenChange, connected, login, link, onOpenSettings }: GithubStatusPopoverProps) {
  return (
    <Popover
      open={open}
      onOpenChange={(next) => { if (connected) onOpenChange(next); }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon"
              onClick={() => { if (!connected) onOpenSettings('project-git'); }}
              className="h-7 w-7 rounded-md text-white/25 hover:text-white/70 hover:bg-white/[0.06]">
              <Github className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent className="z-[300]"><p>{connected ? 'GitHub' : 'Connect GitHub'}</p></TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 z-[300] p-3 space-y-2">
        <p className="text-[11px] text-white/45">
          Connected as <strong className="text-white/80">{login}</strong>
        </p>
        {link ? (
          <a href={`https://github.com/${link.fullName}`} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-[12px] text-indigo-400 hover:text-indigo-300">
            <ExternalLink className="h-3 w-3" />
            {link.fullName} ({link.branch})
          </a>
        ) : (
          <p className="text-[11px] text-white/45">No repository linked yet.</p>
        )}
        <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); onOpenSettings('project-git'); }}
          className="h-7 w-full text-[11px]">
          Manage
        </Button>
      </PopoverContent>
    </Popover>
  );
}
