import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlContent,
} from "./types.js";
import { safeJoin } from "@/ipc/utils/path_utils";

const ensureViteBaseTemplateSchema = z.object({
  overwriteExisting: z
    .boolean()
    .optional()
    .describe("When true, overwrite existing base template files"),
});

const BASE_TEMPLATE_FILES: Readonly<Record<string, string>> = {
  "package.json": `{
  "name": "vite-react-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.0"
  }
}
`,
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + React + TS</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  "vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`,
  "tsconfig.json": `{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
`,
  "tsconfig.app.json": `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": false,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
`,
  "tsconfig.node.json": `{
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
`,
  "src/main.tsx": `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
  "src/App.tsx": `export default function App() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>Vite + React + TypeScript</h1>
      <p>Base project initialized. Ask me what to build next.</p>
    </main>
  );
}
`,
  "src/index.css": `:root {
  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  margin: 0;
  min-height: 100%;
}
`,
  "src/vite-env.d.ts": `/// <reference types="vite/client" />
`,
};

export const ensureViteBaseTemplateTool: ToolDefinition<
  z.infer<typeof ensureViteBaseTemplateSchema>
> = {
  name: "ensure_vite_base_template",
  description:
    "Ensure a Vite + React + TypeScript base scaffold exists. Creates missing core project files and keeps existing files by default.",
  inputSchema: ensureViteBaseTemplateSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) =>
    args.overwriteExisting
      ? "Initialize Vite base template (overwrite enabled)"
      : "Initialize Vite base template (missing files only)",

  buildXml: () =>
    `<dyad-status title="Preparing base template">Ensuring Vite + React + TypeScript scaffold</dyad-status>`,

  execute: async (args, ctx: AgentContext) => {
    const overwrite = args.overwriteExisting ?? false;
    const created: string[] = [];
    const skipped: string[] = [];
    const overwritten: string[] = [];

    for (const [relativePath, content] of Object.entries(BASE_TEMPLATE_FILES)) {
      const fullPath = safeJoin(ctx.appPath, relativePath);
      const exists = fs.existsSync(fullPath);

      if (exists && !overwrite) {
        skipped.push(relativePath);
        continue;
      }

      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf8");

      if (exists) {
        overwritten.push(relativePath);
      } else {
        created.push(relativePath);
      }
    }

    const lines: string[] = [];
    lines.push("Vite base template check complete.");
    lines.push(`Created: ${created.length}`);
    lines.push(`Overwritten: ${overwritten.length}`);
    lines.push(`Skipped existing: ${skipped.length}`);

    if (created.length > 0) {
      lines.push(`Created files: ${created.join(", ")}`);
    }
    if (overwritten.length > 0) {
      lines.push(`Overwritten files: ${overwritten.join(", ")}`);
    }

    const summary = lines.join("\n");

    ctx.onXmlComplete(
      `<dyad-status title="Base template ready">${escapeXmlContent(summary)}</dyad-status>`,
    );

    return summary;
  },
};
