import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { SmesLoader } from '@/lib/smesLoader';

export interface SmesLoaderHandle {
  start: () => void;
  stop: () => void;
  replay: () => void;
  setProgress: (p: number) => void;
}

interface SmesLoaderProps {
  variant?: 'typing' | 'bars' | 'dots';
  text?: string;
  speed?: number;
  autoStart?: boolean;
  className?: string;
}

const SmesLoaderComponent = forwardRef<SmesLoaderHandle, SmesLoaderProps>(
  ({ variant = 'typing', text, speed, autoStart = true, className }, ref) => {
    const elRef = useRef<HTMLDivElement>(null);
    const loaderRef = useRef<SmesLoader | null>(null);

    useEffect(() => {
      if (!elRef.current) return;
      const loader = new SmesLoader(elRef.current, { variant, text, speed });
      loaderRef.current = loader;
      if (autoStart) loader.start();
      return () => { loader.stop(); loaderRef.current = null; };
    }, [variant, text, speed, autoStart]);

    useImperativeHandle(ref, () => ({
      start: () => loaderRef.current?.start(),
      stop: () => loaderRef.current?.stop(),
      replay: () => loaderRef.current?.replay(),
      setProgress: (p: number) => loaderRef.current?.setProgress(p),
    }), []);

    return <div ref={elRef} className={className} />;
  }
);

SmesLoaderComponent.displayName = 'SmesLoader';

export default SmesLoaderComponent;
