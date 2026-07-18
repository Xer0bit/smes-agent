import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          glow: "hsl(var(--primary-glow))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        trigger: {
          DEFAULT: "hsl(var(--trigger))",
          foreground: "hsl(var(--trigger-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        surface: {
          0: "hsl(var(--surface-0))",
          1: "hsl(var(--surface-1))",
          2: "hsl(var(--surface-2))",
          3: "hsl(var(--surface-3))",
        },
        workspace: {
          surface: "hsl(var(--workspace-surface))",
          "surface-recessed": "hsl(var(--workspace-surface-recessed))",
        },
        text: {
          strong: "hsl(var(--text-strong))",
          muted: "hsl(var(--text-muted))",
          soft: "hsl(var(--text-soft))",
        },
        action: {
          primary: "hsl(var(--action-primary))",
          secondary: "hsl(var(--action-secondary))",
        },
        feedback: {
          success: "hsl(var(--feedback-success))",
          warning: "hsl(var(--feedback-warning))",
          danger: "hsl(var(--feedback-danger))",
          info: "hsl(var(--feedback-info))",
        },
      },
      backgroundImage: {
        'gradient-hero': 'var(--gradient-hero)',
        'gradient-primary': 'var(--gradient-primary)',
        'gradient-accent': 'var(--gradient-accent)',
        'gradient-card': 'var(--gradient-card)',
      },
      boxShadow: {
        'glow': 'var(--shadow-glow)',
        'glow-accent': 'var(--shadow-glow-accent)',
        'elegant': 'var(--shadow-elegant)',
        'elev1': 'var(--elev-1)',
        'elev2': 'var(--elev-2)',
      },
      // 'smooth' used to live under transitionProperty mapped straight to the
      // --transition-smooth CSS var, whose value is a full shorthand ("all 0.3s
      // cubic-bezier(...)") — invalid for transition-property, which only takes
      // property names. That produced `transition-property: var(--transition-smooth)`
      // (a malformed value) plus Tailwind's own default 150ms duration, so the
      // class silently never gave the intended 300ms — confirmed by compiling it
      // directly and inspecting the output. Never used anywhere in the app, so
      // this had never been caught. Tailwind's default transitionTimingFunction
      // (cubic-bezier(0.4,0,0.2,1)) already matches what --transition-smooth
      // intended, so only the duration needed a real token.
      transitionDuration: {
        smooth: '300ms',
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(200%)" },
        },
        "loader-breathe": {
          "0%, 100%": { opacity: "0.6", transform: "translateX(-50%) scale(1)" },
          "50%": { opacity: "1", transform: "translateX(-50%) scale(1.08)" },
        },
        "loader-ring": {
          "0%": { opacity: "0.6", transform: "scale(1)" },
          "100%": { opacity: "0", transform: "scale(1.25)" },
        },
        "loader-pulse-dot": {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "1" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        shimmer: "shimmer 1.8s infinite",
        "fade-in": "fade-in 0.6s ease-out",
        "fade-in-up": "fade-in-up 0.8s ease-out forwards",
        "loader-breathe": "loader-breathe 6s ease-in-out infinite",
        "loader-ring": "loader-ring 3s ease-out infinite",
        "loader-pulse-dot": "loader-pulse-dot 2s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
} satisfies Config;
