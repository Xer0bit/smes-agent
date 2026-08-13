import React, { useEffect, useState } from 'react';

interface TypewriterLineProps {
  /** The line to type out. Retypes from scratch whenever this changes. */
  text: string;
  speed?: number;
  className?: string;
}

/**
 * Types `text` out once, character by character, then leaves a blinking
 * cursor. Used for the single-line "what the agent is doing right now"
 * status headline -- not for streamed chat content, which already reveals
 * itself token-by-token from the network.
 */
export const TypewriterLine: React.FC<TypewriterLineProps> = ({ text, speed = 22, className = '' }) => {
  const [shown, setShown] = useState('');

  useEffect(() => {
    setShown('');
    if (!text) return;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [text, speed]);

  return (
    <span className={className}>
      {shown}
      <span className="inline-block w-[2px] h-[11px] ml-0.5 bg-indigo-300/70 align-middle animate-blink" />
    </span>
  );
};

export default TypewriterLine;
