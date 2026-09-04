import { type SVGProps } from 'react';

type BrandLoaderVariant = 'orbit' | 'assemble' | 'bead' | 'sonar' | 'compass' | 'drop' | 'cascade';

interface BrandLoaderProps extends SVGProps<SVGSVGElement> {
  variant?: BrandLoaderVariant;
  size?: number;
  label?: string;
}

const ChevronPath = "M -22 -26 L 4 0 L -22 26";
const ChevronUpper = "M -22 -26 L 4 0";
const ChevronLower = "M 4 0 L -22 26";
const CursorRect = { x: 14, y: -15, width: 12, height: 30, rx: 2 };

function Orbit({ label }: { label: string }) {
  return (
    <svg className="brand-loader__mark orbit" viewBox="-50 -50 100 100" aria-label={label}>
      <path className="brand-loader__chev" d={ChevronPath} />
      <g className="brand-loader__sat">
        <rect className="brand-loader__cur" {...CursorRect} />
      </g>
    </svg>
  );
}

function Assemble({ label }: { label: string }) {
  return (
    <svg className="brand-loader__mark asm" viewBox="-50 -50 100 100" aria-label={label}>
      <path className="brand-loader__chev arm1" d={ChevronUpper} />
      <path className="brand-loader__chev arm2" d={ChevronLower} />
      <rect className="brand-loader__cur" {...CursorRect} />
    </svg>
  );
}

function Bead({ label }: { label: string }) {
  return (
    <svg className="brand-loader__mark bead" viewBox="-50 -50 100 100" aria-label={label}>
      <path className="brand-loader__chev" d={ChevronPath} />
      <path className="brand-loader__chev brand-loader__glow" d={ChevronPath}>
        <animate attributeName="stroke-dashoffset" dur="3s" repeatCount="indefinite"
                 values="74;74;0;0;74" keyTimes="0;.3;.62;.7;.7" />
        <animate attributeName="opacity" dur="3s" repeatCount="indefinite"
                 values="1;1;1;0;0" keyTimes="0;.3;.62;.7;1" />
      </path>
      <rect className="brand-loader__cur" {...CursorRect}>
        <animate attributeName="height" dur="3s" repeatCount="indefinite"
                 values="30;12;12;30;30" keyTimes="0;.12;.88;1;1"
                 calcMode="spline" keySplines=".4 0 .2 1;0 0 1 1;.4 0 .2 1;0 0 1 1" />
        <animate attributeName="y" dur="3s" repeatCount="indefinite"
                 values="-15;-6;-6;-15;-15" keyTimes="0;.12;.88;1;1"
                 calcMode="spline" keySplines=".4 0 .2 1;0 0 1 1;.4 0 .2 1;0 0 1 1" />
        <animate attributeName="rx" dur="3s" repeatCount="indefinite"
                 values="2;6;6;2;2" keyTimes="0;.12;.88;1;1" />
        <animate attributeName="opacity" dur="3s" repeatCount="indefinite"
                 values="1;1;0;0;1;1" keyTimes="0;.12;.13;.87;.88;1" />
      </rect>
      <circle className="brand-loader__cur" r="6" opacity="0">
        <animate attributeName="opacity" dur="3s" repeatCount="indefinite"
                 values="0;0;1;1;0;0" keyTimes="0;.12;.13;.87;.88;1" />
        <animateMotion dur="3s" repeatCount="indefinite" calcMode="linear"
                       path="M 20 0 L 20 0 L -22 -26 L 4 0 L -22 26 L 20 0 L 20 0"
                       keyPoints="0;0;.287;.5;.713;1;1" keyTimes="0;.12;.3;.46;.62;.88;1" />
      </circle>
    </svg>
  );
}

function Sonar({ label }: { label: string }) {
  return (
    <svg className="brand-loader__mark sonar" viewBox="-50 -50 100 100" aria-label={label}>
      <g>
        <path className="brand-loader__echo" d={ChevronPath} />
        <path className="brand-loader__echo" d={ChevronPath} />
        <path className="brand-loader__echo" d={ChevronPath} />
      </g>
      <path className="brand-loader__chev" d={ChevronPath} />
      <rect className="brand-loader__cur" {...CursorRect} />
    </svg>
  );
}

function Compass({ label }: { label: string }) {
  return (
    <svg className="brand-loader__mark compass" viewBox="-50 -50 100 100" aria-label={label}>
      <g>
        <path className="brand-loader__chev" d={ChevronPath} />
        <rect className="brand-loader__cur" {...CursorRect} />
      </g>
    </svg>
  );
}

function Drop({ label }: { label: string }) {
  return (
    <svg className="brand-loader__mark drop" viewBox="-50 -50 100 100" aria-label={label}>
      <path className="brand-loader__chev" d={ChevronPath} />
      <rect className="brand-loader__cur" {...CursorRect} />
    </svg>
  );
}

function Cascade({ label }: { label: string }) {
  return (
    <svg className="brand-loader__mark cascade" viewBox="-50 -50 100 100" aria-label={label}>
      <path className="brand-loader__chev" d="M -66 -26 L -40 0 L -66 26" />
      <path className="brand-loader__chev" d="M -44 -26 L -18 0 L -44 26" />
      <path className="brand-loader__chev" d="M -22 -26 L 4 0 L -22 26" />
      <rect className="brand-loader__cur" {...CursorRect} />
    </svg>
  );
}

const variants: Record<BrandLoaderVariant, React.FC<{ label: string }>> = {
  orbit: Orbit,
  assemble: Assemble,
  bead: Bead,
  sonar: Sonar,
  compass: Compass,
  drop: Drop,
  cascade: Cascade,
};

export default function BrandLoader({
  variant = 'orbit',
  size = 120,
  label = 'Loading',
  className,
  ...props
}: BrandLoaderProps) {
  const Component = variants[variant];
  return (
    <div className={className} style={{ width: size, height: size }} {...props}>
      <Component label={label} />
    </div>
  );
}
