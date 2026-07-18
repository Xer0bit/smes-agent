import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    headers: {
      // Security headers removed to allow blob: URLs for ES modules in local preview
    },
    cors: {
      origin: [
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "https://preview.ecomgear.app",
        "https://api.ecomgear.dev",
        "https://gen.ecomgear.dev",
        "https://agent.ecomgear.dev",
      ],
      credentials: true,
    },
    // Fix HMR WebSocket connection issues
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: 8080,
    },
  },
  plugins: [react()], // Disabled componentTagger to fix preamble error
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      react: path.resolve(__dirname, "./node_modules/react"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
      "react/jsx-runtime": path.resolve(__dirname, "./node_modules/react/jsx-runtime.js"),
      "react/jsx-dev-runtime": path.resolve(__dirname, "./node_modules/react/jsx-dev-runtime.js"),
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/__tests__/setup.ts',
    css: true,
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'vendor-react';
          }

          if (id.includes('/@supabase/')) {
            return 'vendor-supabase';
          }

          if (id.includes('/lucide-react/')) {
            return 'vendor-lucide-react';
          }

          if (id.includes('/monaco-editor/') || id.includes('/@monaco-editor/')) {
            return 'vendor-monaco';
          }

          if (id.includes('/radix-ui/') || id.includes('/@floating-ui/')) {
            return 'vendor-ui';
          }

          if (id.includes('/react-markdown/') || id.includes('/remark-') || id.includes('/rehype-') || id.includes('/micromark') || id.includes('/mdast-') || id.includes('/hast-') || id.includes('/unist-') || id.includes('/vfile')) {
            return 'vendor-markdown';
          }

          if (id.includes('/framer-motion/') || id.includes('/motion-dom/') || id.includes('/motion-utils/')) {
            return 'vendor-motion';
          }

          if (id.includes('/jszip/')) {
            return 'vendor-jszip';
          }
        },
      },
    },
  },
}));
