import { useState, useEffect } from "react";
import { X } from "lucide-react";

const STORAGE_KEY = "smes_alkhidmat_banner_dismissed";
const EVENT_URL = "https://alkhidmat.org/get-involved/events/alkhidmat-ai-hackathon-event";

const MARQUEE_TEXT =
  "AI Hackathon Pakistan 2026 is a national platform where students, developers, entrepreneurs, and AI enthusiasts can learn, innovate, and solve real-world challenges using Artificial Intelligence. Whether you are a beginner or an experienced innovator, this hackathon offers an opportunity to transform ideas into impactful AI solutions.";

export default function AlkhidmatBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!sessionStorage.getItem(STORAGE_KEY)) setVisible(true);
  }, []);

  if (!visible) return null;

  return (
    <>
      <style>{`
        @keyframes marquee-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .marquee-track {
          animation: marquee-scroll 40s linear infinite;
        }
        .marquee-track:hover {
          animation-play-state: paused;
        }
      `}</style>
      <div className="flex items-center h-10 bg-[#0a0a0a] border-b border-white/[0.06] shrink-0">
        <a
          href={EVENT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-4 h-full shrink-0 border-r border-white/[0.06] hover:bg-white/[0.03] transition-colors"
        >
          <span className="text-white/90 text-[12px] font-semibold tracking-wider uppercase whitespace-nowrap">
            AI Hackathon
          </span>
          <span className="text-white/30 text-[12px]">Aug 7, 2026</span>
        </a>

        <div className="flex-1 overflow-hidden min-w-0 relative">
          <div className="marquee-track flex whitespace-nowrap py-0">
            <span className="text-white/40 text-[12px] tracking-wide px-8">
              {MARQUEE_TEXT}
            </span>
            <span className="text-white/40 text-[12px] tracking-wide px-8">
              {MARQUEE_TEXT}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            setVisible(false);
            sessionStorage.setItem(STORAGE_KEY, "1");
          }}
          className="text-white/30 hover:text-white/60 transition-colors px-3 h-full shrink-0 border-l border-white/[0.06]"
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </div>
    </>
  );
}
