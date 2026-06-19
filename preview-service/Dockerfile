FROM node:20-alpine AS deps

# Install git + build essentials for native modules
RUN apk add --no-cache git python3 make g++

WORKDIR /app

# Copy package files first — Docker layer cache means npm install only
# re-runs when package.json actually changes.
COPY package*.json ./

# Install ALL dependencies (devDeps needed for Vite/TypeScript/PostCSS).
# --prefer-offline uses the local npm cache when available.
RUN npm install --production=false --prefer-offline --no-audit --no-fund \
    && npm cache clean --force

# ── Production image ─────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./

# Copy server file
COPY server.js .

# Create projects directory for multi-tenant projects
RUN mkdir -p projects

# Pre-warm Vite dependency optimization cache.
# Creates a throwaway project, runs Vite's dep optimizer once, then copies
# the resulting .vite-cache so every real project starts pre-optimized.
RUN mkdir -p /tmp/_warmup/src \
    && echo '{"name":"warmup","private":true,"type":"module","dependencies":{}}' > /tmp/_warmup/package.json \
    && ln -s /app/node_modules /tmp/_warmup/node_modules \
    && echo 'import "react"; import "react-dom"; import "react-router-dom"; import "lucide-react";' > /tmp/_warmup/src/main.tsx \
    && echo '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' > /tmp/_warmup/index.html \
    && node -e " \
      const vite = require('vite'); \
      const react = require('@vitejs/plugin-react'); \
      (async () => { \
        const s = await vite.createServer({ \
          configFile: false, root: '/tmp/_warmup', \
          plugins: [react()], \
          cacheDir: '/tmp/_warmup/.vite-cache', \
          server: { middlewareMode: true }, \
          optimizeDeps: { include: [ \
            'react','react-dom','react-router-dom','lucide-react', \
            'framer-motion','recharts','date-fns','sonner','clsx', \
            'class-variance-authority','tailwind-merge','zod', \
            '@radix-ui/react-dialog','@radix-ui/react-dropdown-menu', \
            '@radix-ui/react-select','@radix-ui/react-tabs', \
            '@radix-ui/react-tooltip','@radix-ui/react-popover', \
            '@radix-ui/react-slot','@radix-ui/react-checkbox', \
            '@radix-ui/react-switch','@radix-ui/react-label', \
            '@radix-ui/react-toast','@radix-ui/react-separator', \
            '@radix-ui/react-accordion','@radix-ui/react-scroll-area', \
            '@tanstack/react-query','embla-carousel-react', \
          ]}, \
        }); \
        await s.close(); \
      })().catch(e => { console.warn('Warmup non-fatal:', e.message); }); \
    " 2>/dev/null || true \
    && mkdir -p /app/.vite-warmup-cache \
    && cp -r /tmp/_warmup/.vite-cache/* /app/.vite-warmup-cache/ 2>/dev/null || true \
    && rm -rf /tmp/_warmup

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001

# Expose port 3001 for HTTP and 24679 for Vite HMR WebSocket
EXPOSE 3001 24679

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3001/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the server
CMD ["node", "server.js"]
