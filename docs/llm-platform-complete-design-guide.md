# eComGear Code Generation Platform - Complete Architecture Document

## Table of Contents
1. [System Overview](#system-overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Technology Stack](#technology-stack)
4. [Database Schema](#database-schema)
5. [File System Structure](#file-system-structure)
6. [Docker Infrastructure](#docker-infrastructure)
7. [Core Services](#core-services)
8. [API Endpoints](#api-endpoints)
9. [AI Code Generation Pipeline](#ai-code-generation-pipeline)
10. [Preview & Build System](#preview--build-system)
11. [Security & Access Control](#security--access-control)
12. [Resource Management](#resource-management)
13. [Monitoring & Logging](#monitoring--logging)
14. [Deployment Strategy](#deployment-strategy)
15. [Scaling Considerations](#scaling-considerations)
16. [Disaster Recovery](#disaster-recovery)

---

## 1. System Overview

### 1.1 Purpose
eComGear is an AI-powered code generation platform that allows users to create full-stack React/TypeScript applications through natural language prompts. The platform generates, edits, previews, and deploys web applications.

### 1.2 Key Features
- AI-powered code generation using Claude API
- Real-time code preview in isolated environments
- Multi-file project management
- Version control and history
- Live collaboration capabilities
- One-click deployment

### 1.3 Core Components
```
┌─────────────────────────────────────────────────────────────┐
│                        Users                                 │
│                     (Web Interface)                          │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│                   API Gateway                                │
│              (Cloudflare Workers)                            │
└────────┬───────────────────────────┬────────────────────────┘
         │                           │
┌────────▼──────────┐      ┌────────▼──────────────────────┐
│  Authentication   │      │   Application Server          │
│   (Supabase Auth) │      │   (Node.js/Express)           │
└───────────────────┘      └────────┬──────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
         ┌──────────▼─────┐  ┌─────▼──────┐  ┌────▼─────────┐
         │   Database     │  │ File System│  │Docker Preview│
         │  (Supabase)    │  │   (VPS)    │  │  Container   │
         └────────────────┘  └────────────┘  └──────────────┘
```

---

## 2. Architecture Diagram

### 2.1 High-Level Architecture
```
┌──────────────────────────────────────────────────────────────────┐
│                          Frontend Layer                           │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                 │
│  │   Editor   │  │  Preview   │  │ File Tree  │                 │
│  │ (Monaco)   │  │  (iframe)  │  │  Explorer  │                 │
│  └────────────┘  └────────────┘  └────────────┘                 │
└──────────────────────────┬───────────────────────────────────────┘
                           │ HTTPS/WSS
┌──────────────────────────▼───────────────────────────────────────┐
│                      API Gateway Layer                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │         Cloudflare Workers (Edge Functions)              │    │
│  │  - Rate Limiting                                         │    │
│  │  - Request Validation                                    │    │
│  │  - Authentication Check                                  │    │
│  │  - Load Balancing                                        │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────┬───────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────┐
│                    Application Server Layer                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   Project    │  │      AI      │  │   Preview    │          │
│  │  Controller  │  │  Generator   │  │   Manager    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │    File      │  │   Version    │  │    Build     │          │
│  │   Manager    │  │   Control    │  │   Service    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└──────────────────────────┬───────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
┌───────▼────────┐ ┌───────▼────────┐ ┌──────▼──────────────┐
│   Database     │ │  File System   │ │  Docker Container   │
│   (Supabase    │ │   /var/        │ │  - Vite Servers     │
│   PostgreSQL)  │ │   ecomgear/    │ │  - Nginx Proxy      │
│                │ │   projects/    │ │  - Node.js Runtime  │
└────────────────┘ └────────────────┘ └─────────────────────┘
```

### 2.2 Data Flow Architecture
```
User Action → API Gateway → Auth Check → Service Router → Execute
                                                   ↓
                                        ┌──────────┴──────────┐
                                        │                     │
                                    Write to DB          Write to FS
                                        │                     │
                                        ↓                     ↓
                                  [Supabase]          [Project Directory]
                                                            ↓
                                                    Docker Container
                                                            ↓
                                                      Vite Build
                                                            ↓
                                                    Preview URL ← User
```

---

## 3. Technology Stack

### 3.1 Frontend
```yaml
Framework: React 18
Language: TypeScript
Build Tool: Vite
State Management: Zustand
Code Editor: Monaco Editor
Styling: Tailwind CSS
HTTP Client: Axios
WebSocket: Socket.io-client
```

### 3.2 Backend
```yaml
Runtime: Node.js 20 LTS
Framework: Express.js
Language: TypeScript
API Style: RESTful + WebSocket
Process Manager: PM2
```

### 3.3 Database & Storage
```yaml
Primary DB: PostgreSQL (Supabase)
File Storage: Local Filesystem (VPS)
Cache: Redis (for session, rate limiting)
```

### 3.4 Infrastructure
```yaml
Hosting: VPS (Hetzner/DigitalOcean)
Edge Network: Cloudflare
Containerization: Docker + Docker Compose
Reverse Proxy: Nginx
SSL/TLS: Let's Encrypt (via Certbot)
```

### 3.5 AI & External Services
```yaml
AI Provider: Anthropic Claude API
Model: claude-3-5-sonnet-20241022-latest
Deployment: Cloudflare Workers (production)
Monitoring: Sentry, LogTail
```

---

## 4. Database Schema

### 4.1 Complete Schema with Relationships

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- USERS & AUTHENTICATION (Managed by Supabase Auth)
-- ============================================

-- users table is managed by Supabase Auth
-- We'll reference auth.users(id) in foreign keys

-- ============================================
-- USER PROFILES
-- ============================================

CREATE TABLE user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  plan_type TEXT DEFAULT 'free' CHECK (plan_type IN ('free', 'pro', 'enterprise')),
  ai_credits_remaining INTEGER DEFAULT 1000,
  storage_used_bytes BIGINT DEFAULT 0,
  max_storage_bytes BIGINT DEFAULT 1073741824, -- 1GB default
  preferences JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- PROJECTS
-- ============================================

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  
  -- Filesystem paths
  docker_path TEXT NOT NULL UNIQUE, -- "/projects/user_abc_project_xyz"
  server_path TEXT NOT NULL UNIQUE, -- "/var/ecomgear/projects/user_abc_project_xyz"
  
  -- Preview configuration
  preview_port INTEGER, -- NULL when not running, e.g., 3001
  preview_url TEXT, -- Generated URL for iframe
  
  -- Project status
  status TEXT DEFAULT 'idle' CHECK (status IN (
    'idle',       -- Not running
    'initializing', -- Creating files
    'installing', -- npm install
    'building',   -- vite build
    'running',    -- Preview server active
    'error',      -- Build/runtime error
    'deploying'   -- Deployment in progress
  )),
  
  -- Configuration
  template_type TEXT DEFAULT 'vite-react-ts',
  node_version TEXT DEFAULT '20',
  package_manager TEXT DEFAULT 'npm' CHECK (package_manager IN ('npm', 'yarn', 'pnpm')),
  
  -- Metadata
  total_files INTEGER DEFAULT 0,
  total_size_bytes BIGINT DEFAULT 0,
  last_built_at TIMESTAMP WITH TIME ZONE,
  last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Settings
  is_public BOOLEAN DEFAULT FALSE,
  auto_save BOOLEAN DEFAULT TRUE,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  deleted_at TIMESTAMP WITH TIME ZONE -- Soft delete
);

CREATE INDEX idx_projects_user_id ON projects(user_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_last_accessed ON projects(last_accessed_at DESC);
CREATE INDEX idx_projects_deleted ON projects(deleted_at) WHERE deleted_at IS NULL;

-- ============================================
-- PROJECT FILES
-- ============================================

CREATE TABLE project_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  
  -- File information
  file_path TEXT NOT NULL, -- Relative path: "src/App.tsx"
  content TEXT NOT NULL,
  content_hash TEXT, -- SHA-256 hash for change detection
  
  -- File metadata
  mime_type TEXT DEFAULT 'text/plain',
  size_bytes INTEGER NOT NULL,
  encoding TEXT DEFAULT 'utf-8',
  
  -- Version control
  version INTEGER DEFAULT 1,
  is_latest BOOLEAN DEFAULT TRUE,
  
  -- Change tracking
  created_by UUID REFERENCES auth.users(id),
  updated_by UUID REFERENCES auth.users(id),
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(project_id, file_path, version)
);

CREATE INDEX idx_project_files_project ON project_files(project_id);
CREATE INDEX idx_project_files_latest ON project_files(project_id, is_latest) WHERE is_latest = TRUE;
CREATE INDEX idx_project_files_path ON project_files(project_id, file_path);

-- ============================================
-- FILE HISTORY (Version Control)
-- ============================================

CREATE TABLE file_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  
  file_path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  version INTEGER NOT NULL,
  
  -- Change metadata
  change_type TEXT CHECK (change_type IN ('create', 'update', 'delete', 'rename')),
  change_description TEXT,
  changed_by UUID REFERENCES auth.users(id),
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_file_history_file ON file_history(file_id);
CREATE INDEX idx_file_history_project ON file_history(project_id);

-- ============================================
-- AI GENERATION LOGS
-- ============================================

CREATE TABLE ai_generations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  
  -- Request details
  prompt TEXT NOT NULL,
  model TEXT NOT NULL, -- "claude-3-5-sonnet-20241022-latest"
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  
  -- Response
  response_data JSONB, -- Full Claude response
  files_generated TEXT[], -- Array of file paths
  files_modified TEXT[],
  files_deleted TEXT[],
  
  -- Performance
  generation_time_ms INTEGER,
  status TEXT CHECK (status IN ('pending', 'success', 'error', 'partial')),
  error_message TEXT,
  
  -- Cost tracking
  estimated_cost_usd DECIMAL(10, 6),
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_ai_generations_project ON ai_generations(project_id);
CREATE INDEX idx_ai_generations_user ON ai_generations(user_id);
CREATE INDEX idx_ai_generations_created ON ai_generations(created_at DESC);

-- ============================================
-- PREVIEW SESSIONS
-- ============================================

CREATE TABLE preview_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  
  -- Session details
  port INTEGER NOT NULL,
  preview_url TEXT NOT NULL,
  process_id INTEGER, -- PID of Vite process
  
  -- Status
  status TEXT DEFAULT 'starting' CHECK (status IN (
    'starting',
    'installing',
    'running',
    'stopped',
    'error'
  )),
  
  -- Resource usage
  memory_mb INTEGER,
  cpu_percent DECIMAL(5, 2),
  
  -- Activity tracking
  last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  auto_stop_at TIMESTAMP WITH TIME ZONE, -- Auto-stop after inactivity
  
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  stopped_at TIMESTAMP WITH TIME ZONE,
  
  error_message TEXT
);

CREATE INDEX idx_preview_sessions_project ON preview_sessions(project_id);
CREATE INDEX idx_preview_sessions_status ON preview_sessions(status);
CREATE INDEX idx_preview_sessions_activity ON preview_sessions(last_activity_at);

-- ============================================
-- BUILD LOGS
-- ============================================

CREATE TABLE build_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  preview_session_id UUID REFERENCES preview_sessions(id),
  
  -- Build information
  build_type TEXT CHECK (build_type IN ('dev', 'production')),
  status TEXT CHECK (status IN ('pending', 'running', 'success', 'failed')),
  
  -- Logs
  stdout TEXT,
  stderr TEXT,
  exit_code INTEGER,
  
  -- Timing
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  duration_ms INTEGER
);

CREATE INDEX idx_build_logs_project ON build_logs(project_id);
CREATE INDEX idx_build_logs_session ON build_logs(preview_session_id);

-- ============================================
-- COLLABORATORS (Future feature)
-- ============================================

CREATE TABLE project_collaborators (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  role TEXT DEFAULT 'viewer' CHECK (role IN ('owner', 'editor', 'viewer')),
  permissions JSONB DEFAULT '{"read": true, "write": false, "delete": false}',
  
  invited_by UUID REFERENCES auth.users(id),
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  accepted_at TIMESTAMP WITH TIME ZONE,
  
  UNIQUE(project_id, user_id)
);

CREATE INDEX idx_collaborators_project ON project_collaborators(project_id);
CREATE INDEX idx_collaborators_user ON project_collaborators(user_id);

-- ============================================
-- API USAGE & RATE LIMITING
-- ============================================

CREATE TABLE api_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER,
  
  response_time_ms INTEGER,
  request_size_bytes INTEGER,
  response_size_bytes INTEGER,
  
  ip_address INET,
  user_agent TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_api_usage_user ON api_usage(user_id);
CREATE INDEX idx_api_usage_created ON api_usage(created_at DESC);

-- ============================================
-- ERROR LOGS
-- ============================================

CREATE TABLE error_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id),
  project_id UUID REFERENCES projects(id),
  
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  stack_trace TEXT,
  
  context JSONB, -- Additional error context
  
  severity TEXT CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  resolved BOOLEAN DEFAULT FALSE,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_error_logs_user ON error_logs(user_id);
CREATE INDEX idx_error_logs_project ON error_logs(project_id);
CREATE INDEX idx_error_logs_severity ON error_logs(severity);

-- ============================================
-- TRIGGERS
-- ============================================

-- Update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_profiles_updated_at BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_project_files_updated_at BEFORE UPDATE ON project_files
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Archive old file versions to history
CREATE OR REPLACE FUNCTION archive_file_version()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.content != NEW.content THEN
    INSERT INTO file_history (
      file_id, project_id, file_path, content, content_hash,
      version, change_type, changed_by
    ) VALUES (
      OLD.id, OLD.project_id, OLD.file_path, OLD.content, OLD.content_hash,
      OLD.version, 'update', NEW.updated_by
    );
    
    NEW.version = OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER archive_file_before_update BEFORE UPDATE ON project_files
  FOR EACH ROW EXECUTE FUNCTION archive_file_version();

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Users can only see their own projects
CREATE POLICY "Users can view own projects"
  ON projects FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own projects"
  ON projects FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own projects"
  ON projects FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own projects"
  ON projects FOR DELETE
  USING (auth.uid() = user_id);

-- Similar policies for project_files
CREATE POLICY "Users can view files of own projects"
  ON project_files FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = project_files.project_id
      AND projects.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can modify files of own projects"
  ON project_files FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = project_files.project_id
      AND projects.user_id = auth.uid()
    )
  );

-- ============================================
-- VIEWS FOR COMMON QUERIES
-- ============================================

-- Project summary with file counts
CREATE VIEW project_summary AS
SELECT 
  p.id,
  p.user_id,
  p.name,
  p.status,
  p.preview_url,
  p.created_at,
  p.updated_at,
  p.last_accessed_at,
  COUNT(DISTINCT pf.id) as file_count,
  SUM(pf.size_bytes) as total_size_bytes,
  MAX(pf.updated_at) as last_file_update
FROM projects p
LEFT JOIN project_files pf ON p.id = pf.project_id AND pf.is_latest = TRUE
WHERE p.deleted_at IS NULL
GROUP BY p.id;

-- User statistics
CREATE VIEW user_statistics AS
SELECT 
  u.id as user_id,
  up.display_name,
  up.plan_type,
  COUNT(DISTINCT p.id) as total_projects,
  COUNT(DISTINCT ps.id) as active_preview_sessions,
  SUM(p.total_size_bytes) as storage_used_bytes,
  up.ai_credits_remaining
FROM auth.users u
LEFT JOIN user_profiles up ON u.id = up.id
LEFT JOIN projects p ON u.id = p.user_id AND p.deleted_at IS NULL
LEFT JOIN preview_sessions ps ON p.id = ps.project_id AND ps.status = 'running'
GROUP BY u.id, up.display_name, up.plan_type, up.ai_credits_remaining;
```

---

## 5. File System Structure

### 5.1 Server Directory Layout

```
/var/ecomgear/
├── projects/                          # User projects
│   ├── user_abc123_project_xyz789/    # Individual project
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx
│   │   │   ├── components/
│   │   │   │   ├── Button.tsx
│   │   │   │   ├── Header.tsx
│   │   │   │   └── Footer.tsx
│   │   │   ├── hooks/
│   │   │   ├── utils/
│   │   │   └── styles/
│   │   ├── public/
│   │   │   ├── favicon.ico
│   │   │   └── assets/
│   │   ├── node_modules/              # After npm install
│   │   ├── dist/                      # Build output
│   │   ├── package.json
│   │   ├── package-lock.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   ├── .gitignore
│   │   └── README.md
│   │
│   └── user_def456_project_uvw012/
│       └── ... (same structure)
│
├── templates/                         # Project templates
│   ├── vite-react-ts/                 # Default template
│   │   ├── src/
│   │   ├── public/
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   └── ... (base files)
│   │
│   ├── vite-react-js/
│   ├── nextjs-ts/
│   └── vue-ts/
│
├── backups/                           # Daily backups
│   ├── 2025-01-09/
│   │   └── projects_backup.tar.gz
│   └── 2025-01-08/
│
├── logs/                              # Application logs
│   ├── application.log
│   ├── error.log
│   ├── access.log
│   └── build.log
│
├── tmp/                               # Temporary files
│   ├── uploads/                       # File uploads
│   └── builds/                        # Temporary build artifacts
│
└── config/                            # Configuration files
    ├── nginx.conf
    ├── docker-compose.yml
    └── pm2.config.js
```

### 5.2 Project Structure Template

**package.json**
```json
{
  "name": "ecomgear-project",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "lint": "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.43",
    "@types/react-dom": "^18.2.17",
    "@typescript-eslint/eslint-plugin": "^6.14.0",
    "@typescript-eslint/parser": "^6.14.0",
    "@vitejs/plugin-react": "^4.2.1",
    "eslint": "^8.55.0",
    "eslint-plugin-react-hooks": "^4.6.0",
    "eslint-plugin-react-refresh": "^0.4.5",
    "typescript": "^5.2.2",
    "vite": "^5.0.8"
  }
}
```

**vite.config.ts**
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000, // Will be overridden dynamically
    strictPort: false
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})
```

**tsconfig.json**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

---

## 6. Docker Infrastructure

### 6.1 Docker Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Host Machine (VPS)                        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │            Docker Container (preview-server)          │  │
│  │                                                        │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐     │  │
│  │  │   Nginx    │  │ Supervisor │  │  Node.js   │     │  │
│  │  │  (Port 80) │  │  (Process  │  │  Runtime   │     │  │
│  │  │            │  │   Manager) │  │            │     │  │
│  │  └────────────┘  └────────────┘  └────────────┘     │  │
│  │                                                        │  │
│  │  ┌──────────────────────────────────────────────┐   │  │
│  │  │       Vite Dev Servers (Dynamic)              │   │  │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐      │   │  │
│  │  │  │Port 3001 │ │Port 3002 │ │Port 3003 │ ...  │   │  │
│  │  │  │Project A │ │Project B │ │Project C │      │   │  │
│  │  │  └──────────┘ └──────────┘ └──────────┘      │   │  │
│  │  └──────────────────────────────────────────────┘   │  │
│  │                                                        │  │
│  │  Mounted Volume: /projects → /var/ecomgear/projects │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Dockerfile

```dockerfile
# /var/ecomgear/docker/Dockerfile
FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    nginx \
    supervisor \
    procps \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create application directory
WORKDIR /app

# Create projects directory
RUN mkdir -p /projects

# Copy configuration files
COPY nginx.conf /etc/nginx/nginx.conf
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Copy process management scripts
COPY scripts/ /app/scripts/
RUN chmod +x /app/scripts/*.sh

# Install global npm packages
RUN npm install -g pm2 concurrently

# Expose ports
# Port 80: Nginx reverse proxy
# Ports 3000-3100: Vite dev servers
EXPOSE 80 3000-3100

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:80/health || exit 1

# Start supervisor
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
```

### 6.3 docker-compose.yml

```yaml
# /var/ecomgear/docker/docker-compose.yml
version: '3.8'

services:
  preview-server:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: ecomgear-preview
    restart: unless-stopped
    
    ports:
      - "80:80"           # Nginx
      - "443:443"         # HTTPS
      - "3000-3100:3000-3100"  # Vite dev servers
    
    volumes:
      # Mount projects directory (read-write)
      - /var/ecomgear/projects:/projects:rw
      
      # Mount logs directory
      - /var/ecomgear/logs/docker:/var/log/ecomgear:rw
      
      # Mount SSL certificates
      - /etc/letsencrypt:/etc/letsencrypt:ro
    
    environment:
      - NODE_ENV=production
      - MAX_CONCURRENT_PROJECTS=50
      - AUTO_CLEANUP_MINUTES=15
      - LOG_LEVEL=info
    
    networks:
      - ecomgear-network
    
    # Resource limits
    deploy:
      resources:
        limits:
          cpus: '4.0'
          memory: 8G
        reservations:
          cpus: '2.0'
          memory: 4G
    
    # Logging configuration
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  # Redis for caching and rate limiting
  redis:
    image: redis:7-alpine
    container_name: ecomgear-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    networks:
      - ecomgear-network
    command: redis-server --appendonly yes

networks:
  ecomgear-network:
    driver: bridge

volumes:
  redis-data:
```

### 6.4 Nginx Configuration

```nginx
# /var/ecomgear/docker/nginx.conf
user www-data;
worker_processes auto;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log warn;

events {
    worker_connections 2048;
    multi_accept on;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Logging
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';
    
    access_log /var/log/nginx/access.log main;

    # Performance
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    client_max_body_size 50M;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml text/javascript 
               application/json application/javascript application/xml+rss;

    # Map project_id to port (loaded dynamically)
    map $uri $preview_port {
        include /etc/nginx/preview-ports.conf;
    }

    # Upstream for API server
    upstream api_server {
        server host.docker.internal:5000;
        keepalive 32;
    }

    # Main server block
    server {
        listen 80;
        server_name preview.ecomgear.com;

        # Health check endpoint
        location /health {
            access_log off;
            return 200 "OK\n";
            add_header Content-Type text/plain;
        }

        # API proxy
        location /api/ {
            proxy_pass http://api_server;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_cache_bypass $http_upgrade;
        }

        # Preview routing: /preview/{project_id}
        location ~ ^/preview/([a-f0-9-]+)(/.*)?$ {
            set $project_id $1;
            set $path $2;
            
            # Get port from database or config
            # This will be dynamically generated
            proxy_pass http://localhost:$preview_port$path;
            
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
            
            # CORS headers for preview
            add_header Access-Control-Allow-Origin *;
            add_header Access-Control-Allow-Methods 'GET, POST, OPTIONS';
            
            # Vite HMR WebSocket support
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            
            # Timeouts
            proxy_connect_timeout 60s;
            proxy_send_timeout 60s;
            proxy_read_timeout 60s;
        }

        # Error pages
        error_page 502 503 504 /50x.html;
        location = /50x.html {
            root /usr/share/nginx/html;
        }
    }

    # HTTPS server (with SSL)
    server {
        listen 443 ssl http2;
        server_name preview.ecomgear.com;

        # SSL configuration
        ssl_certificate /etc/letsencrypt/live/preview.ecomgear.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/preview.ecomgear.com/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        ssl_prefer_server_ciphers on;

        # Same locations as HTTP server
        # ... (copy from above)
    }
}
```

### 6.5 Supervisor Configuration

```ini
# /var/ecomgear/docker/supervisord.conf
[supervisord]
nodaemon=true
logfile=/var/log/supervisor/supervisord.log
pidfile=/var/run/supervisord.pid
childlogdir=/var/log/supervisor

[program:nginx]
command=/usr/sbin/nginx -g "daemon off;"
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/nginx.log
stderr_logfile=/var/log/supervisor/nginx_error.log

[program:process-manager]
command=node /app/scripts/process-manager.js
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/process-manager.log
stderr_logfile=/var/log/supervisor/process-manager_error.log

[program:cleanup-service]
command=node /app/scripts/cleanup-service.js
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/cleanup.log
stderr_logfile=/var/log/supervisor/cleanup_error.log
```

### 6.6 Process Manager Script

```javascript
// /var/ecomgear/docker/scripts/process-manager.js
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

class ProcessManager {
  constructor() {
    this.processes = new Map(); // Map<projectId, Process>
    this.ports = new Map(); // Map<port, projectId>
    this.portRange = { min: 3000, max: 3100 };
  }

  async findAvailablePort() {
    for (let port = this.portRange.min; port <= this.portRange.max; port++) {
      if (!this.ports.has(port)) {
        return port;
      }
    }
    throw new Error('No available ports');
  }

  async startPreview(projectId, projectPath) {
    if (this.processes.has(projectId)) {
      console.log(`Preview already running for project: ${projectId}`);
      return this.processes.get(projectId);
    }

    const port = await this.findAvailablePort();
    const fullPath = path.join('/projects', projectPath);

    console.log(`Starting preview for ${projectId} on port ${port}`);

    // Check if node_modules exists
    const nodeModulesPath = path.join(fullPath, 'node_modules');
    try {
      await fs.access(nodeModulesPath);
    } catch {
      console.log('Installing dependencies...');
      await this.runCommand('npm install', fullPath);
    }

    // Start Vite dev server
    const viteProcess = spawn('npx', ['vite', '--port', port.toString(), '--host', '0.0.0.0'], {
      cwd: fullPath,
      env: { ...process.env, PORT: port.toString() },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    viteProcess.stdout.on('data', (data) => {
      console.log(`[${projectId}] ${data.toString()}`);
    });

    viteProcess.stderr.on('data', (data) => {
      console.error(`[${projectId}] ERROR: ${data.toString()}`);
    });

    viteProcess.on('exit', (code) => {
      console.log(`Preview stopped for ${projectId} (exit code: ${code})`);
      this.processes.delete(projectId);
      this.ports.delete(port);
    });

    const processInfo = {
      process: viteProcess,
      port,
      projectId,
      startedAt: new Date(),
      lastActivity: new Date()
    };

    this.processes.set(projectId, processInfo);
    this.ports.set(port, projectId);

    // Update nginx config
    await this.updateNginxConfig();

    return processInfo;
  }

  async stopPreview(projectId) {
    const processInfo = this.processes.get(projectId);
    if (!processInfo) {
      console.log(`No preview running for project: ${projectId}`);
      return;
    }

    console.log(`Stopping preview for ${projectId}`);
    processInfo.process.kill('SIGTERM');
    
    this.processes.delete(projectId);
    this.ports.delete(processInfo.port);

    await this.updateNginxConfig();
  }

  async updateNginxConfig() {
    // Generate nginx config mapping project IDs to ports
    let config = '';
    for (const [projectId, info] of this.processes) {
      config += `~^/preview/${projectId} ${info.port};\n`;
    }

    await fs.writeFile('/etc/nginx/preview-ports.conf', config);
    
    // Reload nginx
    exec('nginx -s reload', (error) => {
      if (error) {
        console.error('Failed to reload nginx:', error);
      }
    });
  }

  runCommand(command, cwd) {
    return new Promise((resolve, reject) => {
      exec(command, { cwd }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }

  getStatus() {
    return {
      activeProjects: this.processes.size,
      availablePorts: this.portRange.max - this.portRange.min - this.ports.size,
      projects: Array.from(this.processes.entries()).map(([id, info]) => ({
        projectId: id,
        port: info.port,
        startedAt: info.startedAt,
        lastActivity: info.lastActivity
      }))
    };
  }
}

// Start HTTP server to receive commands
const express = require('express');
const app = express();
app.use(express.json());

const manager = new ProcessManager();

app.post('/start', async (req, res) => {
  try {
    const { projectId, projectPath } = req.body;
    const info = await manager.startPreview(projectId, projectPath);
    res.json({ success: true, port: info.port });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/stop', async (req, res) => {
  try {
    const { projectId } = req.body;
    await manager.stopPreview(projectId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/status', (req, res) => {
  res.json(manager.getStatus());
});

app.listen(9000, () => {
  console.log('Process manager listening on port 9000');
});
```

---

## 7. Core Services

### 7.1 Application Server Structure

```
/var/ecomgear/server/
├── src/
│   ├── index.ts                    # Entry point
│   ├── app.ts                      # Express app setup
│   │
│   ├── config/
│   │   ├── database.ts             # DB connection
│   │   ├── redis.ts                # Redis connection
│   │   ├── anthropic.ts            # Claude API config
│   │   └── environment.ts          # Environment variables
│   │
│   ├── controllers/
│   │   ├── auth.controller.ts
│   │   ├── project.controller.ts
│   │   ├── file.controller.ts
│   │   ├── ai.controller.ts
│   │   └── preview.controller.ts
│   │
│   ├── services/
│   │   ├── auth.service.ts
│   │   ├── project.service.ts
│   │   ├── file.service.ts
│   │   ├── ai-generator.service.ts
│   │   ├── preview.service.ts
│   │   ├── docker.service.ts
│   │   └── cleanup.service.ts
│   │
│   ├── repositories/
│   │   ├── project.repository.ts
│   │   ├── file.repository.ts
│   │   └── user.repository.ts
│   │
│   ├── middleware/
│   │   ├── auth.middleware.ts
│   │   ├── validation.middleware.ts
│   │   ├── rate-limit.middleware.ts
│   │   └── error.middleware.ts
│   │
│   ├── utils/
│   │   ├── file-system.util.ts
│   │   ├── path.util.ts
│   │   ├── hash.util.ts
│   │   └── logger.util.ts
│   │
│   ├── types/
│   │   ├── project.types.ts
│   │   ├── file.types.ts
│   │   └── api.types.ts
│   │
│   └── routes/
│       ├── index.ts
│       ├── auth.routes.ts
│       ├── project.routes.ts
│       ├── file.routes.ts
│       ├── ai.routes.ts
│       └── preview.routes.ts
│
├── package.json
├── tsconfig.json
└── .env
```

### 7.2 Project Service Implementation

```typescript
// src/services/project.service.ts
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ProjectRepository } from '../repositories/project.repository';
import { FileService } from './file.service';
import { logger } from '../utils/logger.util';

export class ProjectService {
  private readonly projectsBasePath = '/var/ecomgear/projects';
  private readonly templatesPath = '/var/ecomgear/templates';

  constructor(
    private projectRepo: ProjectRepository,
    private fileService: FileService
  ) {}

  async createProject(userId: string, name: string, template: string = 'vite-react-ts') {
    const projectId = uuidv4();
    const dirName = `user_${userId.substring(0, 8)}_project_${projectId.substring(0, 8)}`;
    const dockerPath = `/projects/${dirName}`;
    const serverPath = path.join(this.projectsBasePath, dirName);

    logger.info(`Creating project: ${name} for user: ${userId}`);

    try {
      // Create database record
      const project = await this.projectRepo.create({
        id: projectId,
        user_id: userId,
        name,
        docker_path: dockerPath,
        server_path: serverPath,
        template_type: template,
        status: 'initializing'
      });

      // Create filesystem directory
      await fs.mkdir(serverPath, { recursive: true });

      // Copy template files
      const templatePath = path.join(this.templatesPath, template);
      await this.copyDirectory(templatePath, serverPath);

      // Read all files and save to database
      const files = await this.getAllFiles(serverPath);
      for (const file of files) {
        const relativePath = path.relative(serverPath, file);
        const content = await fs.readFile(file, 'utf-8');
        
        await this.fileService.createFile(projectId, relativePath, content, userId);
      }

      // Update project status
      await this.projectRepo.update(projectId, {
        status: 'idle',
        total_files: files.length
      });

      logger.info(`Project created successfully: ${projectId}`);
      return project;

    } catch (error) {
      logger.error(`Failed to create project: ${error.message}`);
      
      // Cleanup on error
      try {
        await fs.rm(serverPath, { recursive: true, force: true });
        await this.projectRepo.delete(projectId);
      } catch (cleanupError) {
        logger.error(`Cleanup failed: ${cleanupError.message}`);
      }
      
      throw error;
    }
  }

  async getProject(projectId: string, userId: string) {
    const project = await this.projectRepo.findById(projectId);
    
    if (!project) {
      throw new Error('Project not found');
    }
    
    if (project.user_id !== userId) {
      throw new Error('Unauthorized access to project');
    }
    
    return project;
  }

  async listProjects(userId: string, filters?: any) {
    return this.projectRepo.findByUserId(userId, filters);
  }

  async updateProject(projectId: string, userId: string, updates: any) {
    await this.getProject(projectId, userId); // Verify access
    
    return this.projectRepo.update(projectId, {
      ...updates,
      updated_at: new Date()
    });
  }

  async deleteProject(projectId: string, userId: string) {
    const project = await this.getProject(projectId, userId);
    
    // Soft delete in database
    await this.projectRepo.softDelete(projectId);
    
    // Delete filesystem (async, don't wait)
    const serverPath = project.server_path.replace('/var/ecomgear/projects/', '');
    const fullPath = path.join(this.projectsBasePath, serverPath);
    
    fs.rm(fullPath, { recursive: true, force: true })
      .then(() => logger.info(`Deleted project files: ${projectId}`))
      .catch(error => logger.error(`Failed to delete project files: ${error.message}`));
    
    return { success: true };
  }

  async getFileTree(projectId: string, userId: string) {
    const project = await this.getProject(projectId, userId);
    const serverPath = project.server_path.replace('/var/ecomgear/projects/', '');
    const fullPath = path.join(this.projectsBasePath, serverPath);
    
    return this.buildFileTree(fullPath);
  }

  private async buildFileTree(dirPath: string, prefix: string = ''): Promise<any> {
    const tree: any = {};
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    // Exclude certain directories
    const excludeDirs = ['node_modules', '.git', 'dist', '.vite', 'build'];

    for (const entry of entries) {
      if (excludeDirs.includes(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.join(prefix, entry.name);

      if (entry.isDirectory()) {
        tree[relativePath] = {
          type: 'directory',
          children: await this.buildFileTree(fullPath, relativePath)
        };
      } else {
        const stats = await fs.stat(fullPath);
        tree[relativePath] = {
          type: 'file',
          size: stats.size,
          modified: stats.mtime
        };
      }
    }

    return tree;
  }

  private async copyDirectory(src: string, dest: string) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  private async getAllFiles(dirPath: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    const excludeDirs = ['node_modules', '.git'];

    for (const entry of entries) {
      if (excludeDirs.includes(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const subFiles = await this.getAllFiles(fullPath);
        files.push(...subFiles);
      } else {
        files.push(fullPath);
      }
    }

    return files;
  }
}
```

### 7.3 AI Generator Service

```typescript
// src/services/ai-generator.service.ts
import Anthropic from '@anthropic-ai/sdk';
import { FileService } from './file.service';
import { ProjectService } from './project.service';
import { logger } from '../utils/logger.util';

export class AIGeneratorService {
  private anthropic: Anthropic;

  constructor(
    private fileService: FileService,
    private projectService: ProjectService
  ) {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  async generateCode(
    projectId: string,
    userId: string,
    prompt: string,
    context?: any
  ) {
    logger.info(`Starting code generation for project: ${projectId}`);

    const startTime = Date.now();

    try {
      // Get project and file tree
      const project = await this.projectService.getProject(projectId, userId);
      const fileTree = await this.projectService.getFileTree(projectId, userId);

      // Get existing files content
      const files = await this.fileService.getProjectFiles(projectId);
      const fileContents = files.map(f => ({
        path: f.file_path,
        content: f.content
      }));

      // Build context for Claude
      const systemPrompt = this.buildSystemPrompt(project);
      const userPrompt = this.buildUserPrompt(prompt, fileTree, fileContents, context);

      // Call Claude API
      const response = await this.anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022-latest',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: userPrompt
        }]
      });

      // Parse response and extract file edits
      const edits = this.parseCodeEdits(response.content);

      // Apply edits to filesystem and database
      const results = await this.applyEdits(projectId, userId, project.server_path, edits);

      const duration = Date.now() - startTime;

      // Log generation
      await this.logGeneration({
        project_id: projectId,
        user_id: userId,
        prompt,
        model: 'claude-3-5-sonnet-20241022-latest',
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
        response_data: response,
        files_generated: results.created,
        files_modified: results.updated,
        files_deleted: results.deleted,
        generation_time_ms: duration,
        status: 'success'
      });

      return {
        success: true,
        edits,
        results,
        usage: response.usage,
        duration
      };

    } catch (error) {
      logger.error(`Code generation failed: ${error.message}`);
      
      await this.logGeneration({
        project_id: projectId,
        user_id: userId,
        prompt,
        model: 'claude-3-5-sonnet-20241022-latest',
        status: 'error',
        error_message: error.message,
        generation_time_ms: Date.now() - startTime
      });

      throw error;
    }
  }

  private buildSystemPrompt(project: any): string {
    return `You are an expert full-stack developer helping to build a ${project.template_type} application.

Your task is to generate or modify code based on user requests. Follow these guidelines:

1. Generate clean, modern, production-ready code
2. Use TypeScript with proper typing
3. Follow React best practices and hooks patterns
4. Use Tailwind CSS for styling
5. Ensure code is well-commented and maintainable

Output format:
For each file edit, use this exact format:

<file_edit>
<path>src/components/Button.tsx</path>
<action>create|update|delete</action>
<content>
// File content here
</content>
</file_edit>

Always specify the complete file path relative to the project root.`;
  }

  private buildUserPrompt(
    prompt: string,
    fileTree: any,
    fileContents: any[],
    context?: any
  ): string {
    return `Current project structure:
${JSON.stringify(fileTree, null, 2)}

Existing files:
${fileContents.map(f => `--- ${f.path} ---\n${f.content}\n`).join('\n')}

${context ? `Additional context:\n${JSON.stringify(context, null, 2)}\n` : ''}

User request:
${prompt}

Please generate or modify the necessary files to fulfill this request.`;
  }

  private parseCodeEdits(content: any[]): any[] {
    const edits: any[] = [];
    
    // Extract text from Claude response
    const text = content.find(c => c.type === 'text')?.text || '';
    
    // Parse <file_edit> blocks
    const fileEditRegex = /<file_edit>([\s\S]*?)<\/file_edit>/g;
    let match;
    
    while ((match = fileEditRegex.exec(text)) !== null) {
      const editContent = match[1];
      
      const pathMatch = /<path>(.*?)<\/path>/.exec(editContent);
      const actionMatch = /<action>(.*?)<\/action>/.exec(editContent);
      const contentMatch = /<content>([\s\S]*?)<\/content>/.exec(editContent);
      
      if (pathMatch && actionMatch && contentMatch) {
        edits.push({
          path: pathMatch[1].trim(),
          action: actionMatch[1].trim(),
          content: contentMatch[1].trim()
        });
      }
    }
    
    return edits;
  }

  private async applyEdits(
    projectId: string,
    userId: string,
    serverPath: string,
    edits: any[]
  ) {
    const results = {
      created: [] as string[],
      updated: [] as string[],
      deleted: [] as string[]
    };

    const basePath = serverPath.replace('/var/ecomgear/projects/', '');
    const fullBasePath = path.join('/var/ecomgear/projects', basePath);

    for (const edit of edits) {
      const filePath = path.join(fullBasePath, edit.path);
      
      try {
        switch (edit.action) {
          case 'create':
          case 'update':
            // Ensure directory exists
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            
            // Write file
            await fs.writeFile(filePath, edit.content, 'utf-8');
            
            // Save to database
            await this.fileService.upsertFile(
              projectId,
              edit.path,
              edit.content,
              userId
            );
            
            if (edit.action === 'create') {
              results.created.push(edit.path);
            } else {
              results.updated.push(edit.path);
            }
            break;

          case 'delete':
            // Delete from filesystem
            await fs.unlink(filePath);
            
            // Mark as deleted in database
            await this.fileService.deleteFile(projectId, edit.path);
            
            results.deleted.push(edit.path);
            break;
        }
      } catch (error) {
        logger.error(`Failed to apply edit for ${edit.path}: ${error.message}`);
      }
    }

    return results;
  }

  private async logGeneration(data: any) {
    // Save to ai_generations table
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    await supabase.from('ai_generations').insert(data);
  }
}
```

### 7.4 Preview Service

```typescript
// src/services/preview.service.ts
import axios from 'axios';
import { ProjectRepository } from '../repositories/project.repository';
import { PreviewSessionRepository } from '../repositories/preview-session.repository';
import { logger } from '../utils/logger.util';

export class PreviewService {
  private readonly dockerManagerUrl = 'http://localhost:9000';
  private readonly previewBaseUrl = 'https://preview.ecomgear.com';

  constructor(
    private projectRepo: ProjectRepository,
    private previewSessionRepo: PreviewSessionRepository
  ) {}

  async startPreview(projectId: string, userId: string) {
    logger.info(`Starting preview for project: ${projectId}`);

    try {
      // Get project
      const project = await this.projectRepo.findById(projectId);
      if (!project || project.user_id !== userId) {
        throw new Error('Project not found or unauthorized');
      }

      // Check if preview already running
      const existingSession = await this.previewSessionRepo.findActiveByProject(projectId);
      if (existingSession) {
        logger.info(`Preview already running for project: ${projectId}`);
        return {
          previewUrl: existingSession.preview_url,
          port: existingSession.port,
          sessionId: existingSession.id
        };
      }

      // Update project status
      await this.projectRepo.update(projectId, { status: 'building' });

      // Request Docker to start preview
      const dockerPath = project.docker_path.split('/').pop();
      const response = await axios.post(`${this.dockerManagerUrl}/start`, {
        projectId,
        projectPath: dockerPath
      });

      if (!response.data.success) {
        throw new Error('Failed to start preview in Docker');
      }

      const port = response.data.port;
      const previewUrl = `${this.previewBaseUrl}/preview/${projectId}`;

      // Create preview session
      const session = await this.previewSessionRepo.create({
        project_id: projectId,
        user_id: userId,
        port,
        preview_url: previewUrl,
        status: 'running',
        auto_stop_at: new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
      });

      // Update project
      await this.projectRepo.update(projectId, {
        status: 'running',
        preview_port: port,
        preview_url: previewUrl,
        last_accessed_at: new Date()
      });

      logger.info(`Preview started successfully: ${projectId} on port ${port}`);

      return {
        previewUrl,
        port,
        sessionId: session.id
      };

    } catch (error) {
      logger.error(`Failed to start preview: ${error.message}`);
      
      await this.projectRepo.update(projectId, {
        status: 'error'
      });

      throw error;
    }
  }

  async stopPreview(projectId: string, userId: string) {
    logger.info(`Stopping preview for project: ${projectId}`);

    try {
      const project = await this.projectRepo.findById(projectId);
      if (!project || project.user_id !== userId) {
        throw new Error('Project not found or unauthorized');
      }

      const session = await this.previewSessionRepo.findActiveByProject(projectId);
      if (!session) {
        logger.info(`No active preview for project: ${projectId}`);
        return { success: true };
      }

      // Request Docker to stop preview
      await axios.post(`${this.dockerManagerUrl}/stop`, {
        projectId
      });

      // Update session
      await this.previewSessionRepo.update(session.id, {
        status: 'stopped',
        stopped_at: new Date()
      });

      // Update project
      await this.projectRepo.update(projectId, {
        status: 'idle',
        preview_port: null,
        preview_url: null
      });

      logger.info(`Preview stopped successfully: ${projectId}`);

      return { success: true };

    } catch (error) {
      logger.error(`Failed to stop preview: ${error.message}`);
      throw error;
    }
  }

  async updateActivity(projectId: string) {
    const session = await this.previewSessionRepo.findActiveByProject(projectId);
    if (session) {
      await this.previewSessionRepo.update(session.id, {
        last_activity_at: new Date(),
        auto_stop_at: new Date(Date.now() + 15 * 60 * 1000)
      });
    }
  }

  async getPreviewStatus(projectId: string, userId: string) {
    const project = await this.projectRepo.findById(projectId);
    if (!project || project.user_id !== userId) {
      throw new Error('Project not found or unauthorized');
    }

    const session = await this.previewSessionRepo.findActiveByProject(projectId);

    return {
      isRunning: !!session && session.status === 'running',
      previewUrl: session?.preview_url,
      port: session?.port,
      startedAt: session?.started_at,
      lastActivity: session?.last_activity_at
    };
  }
}
```

---

## 8. API Endpoints

### 8.1 Authentication Routes

```typescript
// src/routes/auth.routes.ts
import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { validateRequest } from '../middleware/validation.middleware';
import { z } from 'zod';

const router = Router();
const authController = new AuthController();

// Register
router.post('/register',
  validateRequest({
    body: z.object({
      email: z.string().email(),
      password: z.string().min(8),
      displayName: z.string().optional()
    })
  }),
  authController.register
);

// Login
router.post('/login',
  validateRequest({
    body: z.object({
      email: z.string().email(),
      password: z.string()
    })
  }),
  authController.login
);

// Refresh token
router.post('/refresh', authController.refreshToken);

// Logout
router.post('/logout', authController.logout);

// Get current user
router.get('/me', authController.getCurrentUser);

export default router;
```

### 8.2 Project Routes

```typescript
// src/routes/project.routes.ts
import { Router } from 'express';
import { ProjectController } from '../controllers/project.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validation.middleware';
import { rateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { z } from 'zod';

const router = Router();
const projectController = new ProjectController();

// All routes require authentication
router.use(authMiddleware);

// List projects
router.get('/',
  projectController.listProjects
);

// Get project
router.get('/:projectId',
  projectController.getProject
);

// Create project
router.post('/',
  rateLimitMiddleware({ max: 10, windowMs: 60000 }), // 10 per minute
  validateRequest({
    body: z.object({
      name: z.string().min(1).max(100),
      description: z.string().optional(),
      template: z.enum(['vite-react-ts', 'vite-react-js', 'nextjs-ts']).optional()
    })
  }),
  projectController.createProject
);

// Update project
router.patch('/:projectId',
  validateRequest({
    body: z.object({
      name: z.string().min(1).max(100).optional(),
      description: z.string().optional()
    })
  }),
  projectController.updateProject
);

// Delete project
router.delete('/:projectId',
  projectController.deleteProject
);

// Get file tree
router.get('/:projectId/tree',
  projectController.getFileTree
);

export default router;
```

### 8.3 File Routes

```typescript
// src/routes/file.routes.ts
import { Router } from 'express';
import { FileController } from '../controllers/file.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validation.middleware';
import { z } from 'zod';

const router = Router();
const fileController = new FileController();

router.use(authMiddleware);

// Get all files in project
router.get('/project/:projectId',
  fileController.getProjectFiles
);

// Get single file
router.get('/project/:projectId/file',
  validateRequest({
    query: z.object({
      path: z.string()
    })
  }),
  fileController.getFile
);

// Create/update file
router.post('/project/:projectId/file',
  validateRequest({
    body: z.object({
      path: z.string(),
      content: z.string(),
      createDirectories: z.boolean().optional()
    })
  }),
  fileController.upsertFile
);

// Delete file
router.delete('/project/:projectId/file',
  validateRequest({
    query: z.object({
      path: z.string()
    })
  }),
  fileController.deleteFile
);

// Get file history
router.get('/project/:projectId/file/history',
  validateRequest({
    query: z.object({
      path: z.string()
    })
  }),
  fileController.getFileHistory
);

export default router;
```

### 8.4 AI Generation Routes

```typescript
// src/routes/ai.routes.ts
import { Router } from 'express';
import { AIController } from '../controllers/ai.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validation.middleware';
import { rateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { z } from 'zod';

const router = Router();
const aiController = new AIController();

router.use(authMiddleware);

// Generate code
router.post('/generate',
  rateLimitMiddleware({ max: 30, windowMs: 60000 }), // 30 per minute
  validateRequest({
    body: z.object({
      projectId: z.string().uuid(),
      prompt: z.string().min(1).max(5000),
      context: z.any().optional()
    })
  }),
  aiController.generateCode
);

// Get generation history
router.get('/history/:projectId',
  aiController.getGenerationHistory
);

// Get single generation
router.get('/generation/:generationId',
  aiController.getGeneration
);

export default router;
```

### 8.5 Preview Routes

```typescript
// src/routes/preview.routes.ts
import { Router } from 'express';
import { PreviewController } from '../controllers/preview.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { rateLimitMiddleware } from '../middleware/rate-limit.middleware';

const router = Router();
const previewController = new PreviewController();

router.use(authMiddleware);

// Start preview
router.post('/:projectId/start',
  rateLimitMiddleware({ max: 20, windowMs: 60000 }),
  previewController.startPreview
);

// Stop preview
router.post('/:projectId/stop',
  previewController.stopPreview
);

// Get preview status
router.get('/:projectId/status',
  previewController.getStatus
);

// Update activity (keep-alive)
router.post('/:projectId/activity',
  previewController.updateActivity
);

export default router;
```

### 8.6 API Documentation Summary

```
BASE_URL: https://api.ecomgear.com/v1

Authentication:
- POST   /auth/register            # Create account
- POST   /auth/login               # Login
- POST   /auth/refresh             # Refresh token
- POST   /auth/logout              # Logout
- GET    /auth/me                  # Get current user

Projects:
- GET    /projects                 # List all projects
- POST   /projects                 # Create new project
- GET    /projects/:id             # Get project details
- PATCH  /projects/:id             # Update project
- DELETE /projects/:id             # Delete project
- GET    /projects/:id/tree        # Get file tree

Files:
- GET    /files/project/:id                    # List all files
- GET    /files/project/:id/file?path=...      # Get file content
- POST   /files/project/:id/file               # Create/update file
- DELETE /files/project/:id/file?path=...      # Delete file
- GET    /files/project/:id/file/history?path=... # File history

AI Generation:
- POST   /ai/generate                          # Generate code
- GET    /ai/history/:projectId                # Get generation history
- GET    /ai/generation/:id                    # Get specific generation

Preview:
- POST   /preview/:projectId/start             # Start preview server
- POST   /preview/:projectId/stop              # Stop preview server
- GET    /preview/:projectId/status            # Get preview status
- POST   /preview/:projectId/activity          # Update activity
```

---

## 9. AI Code Generation Pipeline

### 9.1 Generation Flow Diagram

```
┌──────────────────┐
│  User Request    │
│  "Add a login    │
│   page with..."  │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────┐
│  1. Context Gathering             │
│  - Load project files             │
│  - Build file tree                │
│  - Get recent changes             │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  2. Prompt Construction           │
│  - System prompt                  │
│  - File context                   │
│  - User requirements              │
│  - Code conventions               │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  3. Claude API Call               │
│  - Model: claude-3-5-sonnet       │
│  - Max tokens: 4096               │
│  - Temperature: 0.7               │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  4. Response Parsing              │
│  - Extract file edits             │
│  - Validate structure             │
│  - Check for errors               │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  5. File Operations               │
│  - Create new files               │
│  - Update existing files          │
│  - Delete obsolete files          │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  6. Database Sync                 │
│  - Save file versions             │
│  - Update metadata                │
│  - Log generation                 │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  7. Response to User              │
│  - Success/failure                │
│  - Files changed                  │
│  - Preview link                   │
└──────────────────────────────────┘
```

### 9.2 Prompt Engineering Strategy

**System Prompt Template:**
```
You are an expert ${technology} developer helping to build a production-grade application.

Project Context:
- Template: ${template_type}
- Stack: React 18 + TypeScript + Vite + Tailwind CSS
- Current file count: ${file_count}

Code Guidelines:
1. Write clean, maintainable, production-ready code
2. Use TypeScript with strict typing
3. Follow React hooks best practices
4. Use functional components only
5. Implement proper error handling
6. Add meaningful comments
7. Follow the existing project structure
8. Use Tailwind CSS for all styling

Output Format:
For each file you create or modify, use this EXACT structure:

<file_edit>
<path>relative/path/to/file.tsx</path>
<action>create|update|delete</action>
<content>
// Complete file content here
</content>
</file_edit>

Rules:
- Always provide complete file content, not diffs
- Use relative paths from project root
- Ensure proper TypeScript types
- Import dependencies correctly
- Follow naming conventions (PascalCase for components, camelCase for functions)
```

**User Prompt Template:**
```
Current Project Structure:
${file_tree_json}

Existing Key Files:
${relevant_files_content}

Recent Changes:
${recent_generation_history}

User Request:
${user_prompt}

Additional Context:
${additional_context}

Please implement this request while maintaining consistency with the existing codebase.
```

### 9.3 Cost Optimization Strategies

```typescript
// Prompt caching strategy
interface CachingStrategy {
  systemPrompt: {
    cache: true,
    cacheExpiry: '5m' // Cache for 5 minutes
  },
  fileContext: {
    cache: true,
    cacheExpiry: '2m' // Cache file tree
  },
  userPrompt: {
    cache: false // Always fresh
  }
}

// Token estimation
function estimateTokens(text: string): number {
  // Rough estimate: 1 token ≈ 4 characters
  return Math.ceil(text.length / 4);
}

// Smart context selection
function selectRelevantFiles(allFiles: File[], prompt: string, maxTokens: number = 8000) {
  // 1. Always include core files
  const coreFiles = ['package.json', 'vite.config.ts', 'tsconfig.json'];
  
  // 2. Find files mentioned in prompt
  const mentionedFiles = allFiles.filter(f => 
    prompt.toLowerCase().includes(f.path.toLowerCase())
  );
  
  // 3. Find files in relevant directories
  const relevantDirs = extractDirectoriesFromPrompt(prompt);
  const dirFiles = allFiles.filter(f =>
    relevantDirs.some(dir => f.path.startsWith(dir))
  );
  
  // 4. Combine and prioritize
  const selectedFiles = [...new Set([
    ...coreFiles,
    ...mentionedFiles.map(f => f.path),
    ...dirFiles.map(f => f.path)
  ])];
  
  // 5. Ensure within token budget
  let totalTokens = 0;
  const finalFiles = [];
  
  for (const file of selectedFiles) {
    const fileTokens = estimateTokens(file.content);
    if (totalTokens + fileTokens <= maxTokens) {
      finalFiles.push(file);
      totalTokens += fileTokens;
    } else {
      break;
    }
  }
  
  return finalFiles;
}
```

### 9.4 Error Handling & Retry Logic

```typescript
async function generateWithRetry(
  params: GenerationParams,
  maxRetries: number = 3
): Promise<GenerationResult> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`Generation attempt ${attempt}/${maxRetries}`);
      
      const result = await generateCode(params);
      
      // Validate result
      if (result.edits.length === 0) {
        throw new Error('No file edits generated');
      }
      
      return result;
      
    } catch (error) {
      lastError = error;
      logger.warn(`Generation attempt ${attempt} failed: ${error.message}`);
      
      // Exponential backoff
      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 1000;
        await sleep(delayMs);
        
        // Modify prompt for retry
        params.prompt += `\n\n[Previous attempt failed: ${error.message}. Please try again with a different approach.]`;
      }
    }
  }
  
  throw new Error(`Generation failed after ${maxRetries} attempts: ${lastError.message}`);
}
```

---

## 10. Preview & Build System

### 10.1 Preview Lifecycle

```
┌─────────────────────────────────────────────────────────┐
│                  Preview Lifecycle                       │
└─────────────────────────────────────────────────────────┘

1. START REQUEST
   └─→ Check if preview exists
       ├─→ Yes: Return existing URL
       └─→ No: Continue

2. RESOURCE ALLOCATION
   └─→ Find available port (3000-3100)
   └─→ Check system resources
   └─→ Create preview session record

3. DEPENDENCY INSTALLATION
   └─→ Check if node_modules exists
       └─→ No: Run 'npm install'
       └─→ Log installation progress

4. VITE SERVER START
   └─→ Spawn vite process
   └─→ Wait for "ready" signal
   └─→ Update session status

5. NGINX ROUTING
   └─→ Add route: /preview/{projectId} → port
   └─→ Reload nginx config

6. RUNNING STATE
   └─→ Serve preview via iframe
   └─→ Track activity (heartbeat every 30s)
   └─→ Monitor resource usage

7. IDLE DETECTION
   └─→ No activity for 15 minutes
   └─→ Send shutdown signal

8. CLEANUP
   └─→ Kill vite process
   └─→ Remove nginx route
   └─→ Release port
   └─→ Update session: stopped
```

### 10.2 Resource Management

```typescript
// Resource monitoring
class ResourceMonitor {
  private readonly maxConcurrentPreviews = 50;
  private readonly maxMemoryPerPreview = 512; // MB
  private readonly maxCpuPerPreview = 25; // percent

  async checkResources(): Promise<ResourceStatus> {
    const activeCount = await this.getActivePreviewCount();
    const systemMemory = await this.getSystemMemory();
    const systemCpu = await this.getSystemCpu();

    return {
      canStart: activeCount < this.maxConcurrentPreviews &&
                systemMemory.available > this.maxMemoryPerPreview &&
                systemCpu.available > this.maxCpuPerPreview,
      activeCount,
      availableSlots: this.maxConcurrentPreviews - activeCount,
      memory: systemMemory,
      cpu: systemCpu
    };
  }

  async enforceResourceLimits(processId: number) {
    // Use cgroups to limit resources
    await exec(`cgset -r memory.limit_in_bytes=${this.maxMemoryPerPreview}M vite-${processId}`);
    await exec(`cgset -r cpu.cfs_quota_us=${this.maxCpuPerPreview * 1000} vite-${processId}`);
  }

  async monitorProcess(processId: number): Promise<ProcessStats> {
    const stats = await pidusage(processId);
    
    if (stats.memory > this.maxMemoryPerPreview * 1024 * 1024) {
      logger.warn(`Process ${processId} exceeding memory limit`);
      // Could trigger restart or alert
    }

    return {
      cpu: stats.cpu,
      memory: stats.memory,
      elapsed: stats.elapsed
    };
  }
}
```

### 10.3 Auto-Cleanup Service

```typescript
// Cleanup service that runs every 5 minutes
class CleanupService {
  private readonly idleTimeout = 15 * 60 * 1000; // 15 minutes
  private readonly maxPreviewAge = 4 * 60 * 60 * 1000; // 4 hours

  async runCleanup() {
    logger.info('Starting cleanup service');

    // 1. Stop idle previews
    await this.stopIdlePreviews();

    // 2. Stop old previews
    await this.stopOldPreviews();

    // 3. Clean orphaned processes
    await this.cleanOrphanedProcesses();

    // 4. Clean temporary files
    await this.cleanTempFiles();

    logger.info('Cleanup service completed');
  }

  private async stopIdlePreviews() {
    const idleSessions = await supabase
      .from('preview_sessions')
      .select('*')
      .eq('status', 'running')
      .lt('last_activity_at', new Date(Date.now() - this.idleTimeout));

    for (const session of idleSessions.data || []) {
      logger.info(`Stopping idle preview: ${session.project_id}`);
      await this.previewService.stopPreview(session.project_id, session.user_id);
    }
  }

  private async stopOldPreviews() {
    const oldSessions = await supabase
      .from('preview_sessions')
      .select('*')
      .eq('status', 'running')
      .lt('started_at', new Date(Date.now() - this.maxPreviewAge));

    for (const session of oldSessions.data || []) {
      logger.info(`Stopping old preview: ${session.project_id}`);
      await this.previewService.stopPreview(session.project_id, session.user_id);
    }
  }

  private async cleanOrphanedProcesses() {
    // Find vite processes not tracked in database
    const { stdout } = await exec(`ps aux | grep "vite --port" | grep -v grep`);
    const processes = stdout.split('\n').filter(Boolean);

    for (const process of processes) {
      const pid = parseInt(process.split(/\s+/)[1]);
      const port = this.extractPort(process);

      const session = await supabase
        .from('preview_sessions')
        .select('*')
        .eq('port', port)
        .eq('status', 'running')
        .single();

      if (!session.data) {
        logger.info(`Killing orphaned process: ${pid} on port ${port}`);
        await exec(`kill ${pid}`);
      }
    }
  }

  private async cleanTempFiles() {
    // Clean files older than 24 hours in /tmp
    await exec(`find /var/ecomgear/tmp -type f -mtime +1 -delete`);
  }
}

// Run cleanup every 5 minutes
setInterval(() => {
  const cleanupService = new CleanupService();
  cleanupService.runCleanup().catch(error => {
    logger.error(`Cleanup failed: ${error.message}`);
  });
}, 5 * 60 * 1000);
```

### 10.4 Build System (Production)

```typescript
// Production build service
class BuildService {
  async buildForProduction(projectId: string, userId: string) {
    const project = await this.projectService.getProject(projectId, userId);
    const buildDir = `/var/ecomgear/tmp/builds/${projectId}`;

    try {
      // 1. Create build directory
      await fs.mkdir(buildDir, { recursive: true });

      // 2. Copy project files
      await this.copyProjectFiles(project.server_path, buildDir);

      // 3. Install dependencies
      await this.runCommand('npm install --production', buildDir);

      // 4. Run build
      const buildResult = await this.runCommand('npm run build', buildDir);

      // 5. Get build artifacts
      const distPath = path.join(buildDir, 'dist');
      const artifacts = await this.getArtifacts(distPath);

      // 6. Log build
      await this.logBuild(projectId, buildResult);

      return {
        success: true,
        artifacts,
        distPath
      };

    } catch (error) {
      logger.error(`Build failed for project ${projectId}: ${error.message}`);
      
      await this.logBuild(projectId, {
        status: 'failed',
        error: error.message
      });

      throw error;
    } finally {
      // Cleanup build directory after 1 hour
      setTimeout(async () => {
        await fs.rm(buildDir, { recursive: true, force: true });
      }, 60 * 60 * 1000);
    }
  }

  private async runCommand(command: string, cwd: string) {
    return new Promise((resolve, reject) => {
      exec(command, { cwd }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }
}
```

---

## 11. Security & Access Control

### 11.1 Authentication Flow

```
┌──────────────┐
│    User      │
└──────┬───────┘
       │
       │ POST /auth/login
       ▼
┌─────────────────┐
│  API Gateway    │
│  (Cloudflare)   │
└──────┬──────────┘
       │
       │ Forward with rate limit
       ▼
┌─────────────────┐
│  Auth Service   │
│  (Supabase)     │
└──────┬──────────┘
       │
       │ Validate credentials
       ▼
┌─────────────────┐
│  Generate Tokens│
│  - Access Token │
│  - Refresh Token│
└──────┬──────────┘
       │
       │ Return to client
       ▼
┌──────────────────┐
│  Store in Memory │
│  (Not localStorage)
└──────────────────┘
```

### 11.2 Authorization Middleware

```typescript
// Auth middleware
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // Extract token from header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);

    // Verify token with Supabase
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Attach user to request
    req.user = {
      id: data.user.id,
      email: data.user.email,
      role: data.user.role
    };

    next();
    } catch (error) {
logger.error(Auth middleware error: ${error.message});
return res.status(500).json({ error: 'Authentication failed' });
}
}
// Project access verification
export async function verifyProjectAccess(
userId: string,
projectId: string,
requiredRole: 'owner' | 'editor' | 'viewer' = 'viewer'
): Promise<boolean> {
// Check if user owns the project
const project = await supabase
.from('projects')
.select('user_id')
.eq('id', projectId)
.single();
if (project.data?.user_id === userId) {
return true;
}
// Check if user is a collaborator
const collaborator = await supabase
.from('project_collaborators')
.select('role')
.eq('project_id', projectId)
.eq('user_id', userId)
.single();
if (!collaborator.data) {
return false;
}
// Check role hierarchy
const roleHierarchy = {
owner: 3,
editor: 2,
viewer: 1
};
return roleHierarchy[collaborator.data.role] >= roleHierarchy[requiredRole];
}

### 11.3 Rate Limiting
```typescript
// Redis-based rate limiter
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

export function rateLimitMiddleware(options: {
  max: number;          // Max requests
  windowMs: number;     // Time window in ms
  keyGenerator?: (req: Request) => string;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = options.keyGenerator 
      ? options.keyGenerator(req)
      : `rate-limit:${req.user.id}:${req.path}`;

    const current = await redis.incr(key);

    if (current === 1) {
      await redis.pexpire(key, options.windowMs);
    }

    if (current > options.max) {
      const ttl = await redis.pttl(key);
      
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil(ttl / 1000)
      });
    }

    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', options.max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, options.max - current));
    res.setHeader('X-RateLimit-Reset', Date.now() + options.windowMs);

    next();
  };
}

// Usage tiers
const RATE_LIMITS = {
  free: {
    ai_generations: { max: 50, windowMs: 24 * 60 * 60 * 1000 }, // 50 per day
    preview_starts: { max: 100, windowMs: 60 * 60 * 1000 },     // 100 per hour
    file_operations: { max: 500, windowMs: 60 * 60 * 1000 }     // 500 per hour
  },
  pro: {
    ai_generations: { max: 500, windowMs: 24 * 60 * 60 * 1000 },
    preview_starts: { max: 1000, windowMs: 60 * 60 * 1000 },
    file_operations: { max: 5000, windowMs: 60 * 60 * 1000 }
  },
  enterprise: {
    ai_generations: { max: 10000, windowMs: 24 * 60 * 60 * 1000 },
    preview_starts: { max: 10000, windowMs: 60 * 60 * 1000 },
    file_operations: { max: 50000, windowMs: 60 * 60 * 1000 }
  }
};
```

### 11.4 File System Security
```typescript
// Path validation and sanitization
export class PathValidator {
  private readonly allowedExtensions = [
    '.ts', '.tsx', '.js', '.jsx', '.css', '.html', 
    '.json', '.md', '.txt', '.svg', '.png', '.jpg'
  ];

  private readonly blockedPaths = [
    '../',
    '..\\',
    '/etc/',
    '/var/',
    '/root/',
    'node_modules',
    '.env'
  ];

  validate(filePath: string): { valid: boolean; error?: string } {
    // Remove leading/trailing slashes
    const normalized = filePath.trim().replace(/^\/+|\/+$/g, '');

    // Check for directory traversal
    if (this.blockedPaths.some(blocked => normalized.includes(blocked))) {
      return { valid: false, error: 'Invalid path: directory traversal detected' };
    }

    // Check file extension
    const ext = path.extname(normalized).toLowerCase();
    if (!this.allowedExtensions.includes(ext)) {
      return { valid: false, error: `File type not allowed: ${ext}` };
    }

    // Check path length
    if (normalized.length > 255) {
      return { valid: false, error: 'Path too long' };
    }

    return { valid: true };
  }

  sanitize(filePath: string): string {
    // Normalize path
    let sanitized = path.normalize(filePath);
    
    // Remove dangerous characters
    sanitized = sanitized.replace(/[<>:"|?*]/g, '');
    
    // Remove multiple slashes
    sanitized = sanitized.replace(/\/+/g, '/');
    
    return sanitized;
  }
}

// File operation with security checks
export async function secureFileWrite(
  projectPath: string,
  filePath: string,
  content: string
): Promise<void> {
  const validator = new PathValidator();
  
  // Validate path
  const validation = validator.validate(filePath);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Sanitize path
  const sanitizedPath = validator.sanitize(filePath);
  const fullPath = path.join(projectPath, sanitizedPath);

  // Ensure path is within project directory
  const resolvedPath = path.resolve(fullPath);
  const resolvedBase = path.resolve(projectPath);
  
  if (!resolvedPath.startsWith(resolvedBase)) {
    throw new Error('Path outside project directory');
  }

  // Check file size
  if (Buffer.byteLength(content, 'utf8') > 10 * 1024 * 1024) { // 10MB
    throw new Error('File too large');
  }

  // Write file
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf8');
}
```

### 11.5 Input Validation
```typescript
// Zod schemas for validation
import { z } from 'zod';

export const ProjectSchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(100, 'Name too long')
    .regex(/^[a-zA-Z0-9-_ ]+$/, 'Invalid characters in name'),
  
  description: z.string()
    .max(500, 'Description too long')
    .optional(),
  
  template: z.enum(['vite-react-ts', 'vite-react-js', 'nextjs-ts'])
    .optional()
});

export const FileSchema = z.object({
  path: z.string()
    .min(1, 'Path is required')
    .max(255, 'Path too long')
    .regex(/^[a-zA-Z0-9-_/.]+$/, 'Invalid characters in path'),
  
  content: z.string()
    .max(10 * 1024 * 1024, 'File too large'), // 10MB
  
  createDirectories: z.boolean().optional()
});

export const AIPromptSchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
  
  prompt: z.string()
    .min(1, 'Prompt is required')
    .max(5000, 'Prompt too long'),
  
  context: z.any().optional()
});

// Validation middleware
export function validateRequest(schemas: {
  body?: z.ZodSchema;
  query?: z.ZodSchema;
  params?: z.ZodSchema;
}) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      
      if (schemas.query) {
        req.query = schemas.query.parse(req.query);
      }
      
      if (schemas.params) {
        req.params = schemas.params.parse(req.params);
      }
      
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: error.errors
        });
      }
      
      next(error);
    }
  };
}
```

---

## 12. Resource Management

### 12.1 System Resource Monitoring
```typescript
// System monitor
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class SystemMonitor {
  async getSystemStats() {
    const [memory, cpu, disk] = await Promise.all([
      this.getMemoryStats(),
      this.getCPUStats(),
      this.getDiskStats()
    ]);

    return {
      memory,
      cpu,
      disk,
      timestamp: new Date()
    };
  }

  private async getMemoryStats() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;

    return {
      total: this.bytesToGB(total),
      used: this.bytesToGB(used),
      free: this.bytesToGB(free),
      usagePercent: (used / total) * 100
    };
  }

  private async getCPUStats() {
    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - ~~(100 * idle / total);

    return {
      cores: cpus.length,
      model: cpus[0].model,
      usage,
      loadAvg: {
        '1min': loadAvg[0],
        '5min': loadAvg[1],
        '15min': loadAvg[2]
      }
    };
  }

  private async getDiskStats() {
    try {
      const { stdout } = await execAsync("df -h /var/ecomgear | tail -1");
      const parts = stdout.trim().split(/\s+/);

      return {
        total: parts[1],
        used: parts[2],
        available: parts[3],
        usagePercent: parseInt(parts[4])
      };
    } catch (error) {
      logger.error('Failed to get disk stats:', error);
      return null;
    }
  }

  private bytesToGB(bytes: number): string {
    return (bytes / (1024 ** 3)).toFixed(2) + ' GB';
  }

  async checkHealth(): Promise<HealthStatus> {
    const stats = await this.getSystemStats();

    const issues = [];

    if (stats.memory.usagePercent > 90) {
      issues.push('High memory usage');
    }

    if (stats.cpu.usage > 90) {
      issues.push('High CPU usage');
    }

    if (stats.disk && stats.disk.usagePercent > 90) {
      issues.push('Low disk space');
    }

    return {
      healthy: issues.length === 0,
      issues,
      stats
    };
  }
}
```

### 12.2 Project Quota Management
```typescript
// User quota tracker
export class QuotaManager {
  async checkQuota(userId: string, action: string): Promise<QuotaResult> {
    const profile = await this.getUserProfile(userId);
    const usage = await this.getCurrentUsage(userId);
    const limits = this.getLimits(profile.plan_type);

    switch (action) {
      case 'create_project':
        return this.checkProjectQuota(usage, limits);
      
      case 'ai_generation':
        return this.checkAIQuota(profile, limits);
      
      case 'storage':
        return this.checkStorageQuota(usage, limits);
      
      default:
        return { allowed: true };
    }
  }

  private async checkProjectQuota(usage: Usage, limits: Limits): Promise<QuotaResult> {
    if (usage.projectCount >= limits.maxProjects) {
      return {
        allowed: false,
        reason: `Project limit reached (${limits.maxProjects})`,
        current: usage.projectCount,
        limit: limits.maxProjects
      };
    }

    return { allowed: true };
  }

  private async checkAIQuota(profile: UserProfile, limits: Limits): Promise<QuotaResult> {
    if (profile.ai_credits_remaining <= 0) {
      return {
        allowed: false,
        reason: 'No AI credits remaining',
        current: 0,
        limit: limits.aiCreditsPerMonth
      };
    }

    return { allowed: true };
  }

  private async checkStorageQuota(usage: Usage, limits: Limits): Promise<QuotaResult> {
    if (usage.storageUsedBytes >= limits.maxStorageBytes) {
      return {
        allowed: false,
        reason: 'Storage limit reached',
        current: usage.storageUsedBytes,
        limit: limits.maxStorageBytes
      };
    }

    return { allowed: true };
  }

  private getLimits(planType: string): Limits {
    const LIMITS = {
      free: {
        maxProjects: 3,
        maxStorageBytes: 1 * 1024 * 1024 * 1024, // 1GB
        aiCreditsPerMonth: 100,
        maxConcurrentPreviews: 1
      },
      pro: {
        maxProjects: 50,
        maxStorageBytes: 10 * 1024 * 1024 * 1024, // 10GB
        aiCreditsPerMonth: 1000,
        maxConcurrentPreviews: 5
      },
      enterprise: {
        maxProjects: 1000,
        maxStorageBytes: 100 * 1024 * 1024 * 1024, // 100GB
        aiCreditsPerMonth: 10000,
        maxConcurrentPreviews: 20
      }
    };

    return LIMITS[planType] || LIMITS.free;
  }

  async consumeCredit(userId: string, amount: number = 1) {
    await supabase
      .from('user_profiles')
      .update({
        ai_credits_remaining: supabase.raw(`ai_credits_remaining - ${amount}`)
      })
      .eq('id', userId);
  }

  async updateStorageUsage(userId: string) {
    const { data: projects } = await supabase
      .from('projects')
      .select('total_size_bytes')
      .eq('user_id', userId)
      .is('deleted_at', null);

    const totalStorage = projects?.reduce((sum, p) => sum + p.total_size_bytes, 0) || 0;

    await supabase
      .from('user_profiles')
      .update({ storage_used_bytes: totalStorage })
      .eq('id', userId);

    return totalStorage;
  }
}
```

### 12.3 Disk Space Management
```typescript
// Disk cleanup strategies
export class DiskManager {
  private readonly projectsPath = '/var/ecomgear/projects';
  private readonly minFreeSpaceGB = 10;

  async ensureSufficientSpace() {
    const stats = await this.getDiskStats();
    const freeGB = parseInt(stats.available);

    if (freeGB < this.minFreeSpaceGB) {
      logger.warn(`Low disk space: ${freeGB}GB free`);
      await this.freeUpSpace();
    }
  }

  private async freeUpSpace() {
    // 1. Delete old build artifacts
    await this.cleanBuildArtifacts();

    // 2. Clean old deleted projects
    await this.cleanDeletedProjects();

    // 3. Clean node_modules from inactive projects
    await this.cleanInactiveNodeModules();

    // 4. Clean temporary files
    await this.cleanTempFiles();
  }

  private async cleanBuildArtifacts() {
    const distDirs = await this.findDistDirs();
    
    for (const dir of distDirs) {
      const stats = await fs.stat(dir);
      const age = Date.now() - stats.mtimeMs;
      
      // Delete dist directories older than 7 days
      if (age > 7 * 24 * 60 * 60 * 1000) {
        await fs.rm(dir, { recursive: true, force: true });
        logger.info(`Deleted old build artifacts: ${dir}`);
      }
    }
  }

  private async cleanDeletedProjects() {
    // Get projects deleted more than 30 days ago
    const { data: deletedProjects } = await supabase
      .from('projects')
      .select('server_path')
      .not('deleted_at', 'is', null)
      .lt('deleted_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

    for (const project of deletedProjects || []) {
      const path = project.server_path.replace('/var/ecomgear/projects/', '');
      const fullPath = `/var/ecomgear/projects/${path}`;
      
      await fs.rm(fullPath, { recursive: true, force: true });
      logger.info(`Permanently deleted project: ${fullPath}`);
    }
  }

  private async cleanInactiveNodeModules() {
    // Get projects not accessed in 30 days
    const { data: inactiveProjects } = await supabase
      .from('projects')
      .select('server_path')
      .lt('last_accessed_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

    for (const project of inactiveProjects || []) {
      const path = project.server_path.replace('/var/ecomgear/projects/', '');
      const nodeModulesPath = `/var/ecomgear/projects/${path}/node_modules`;
      
      try {
        await fs.access(nodeModulesPath);
        await fs.rm(nodeModulesPath, { recursive: true, force: true });
        logger.info(`Cleaned node_modules for inactive project: ${path}`);
      } catch {
        // node_modules doesn't exist, skip
      }
    }
  }

  private async cleanTempFiles() {
    await exec('find /var/ecomgear/tmp -type f -mtime +1 -delete');
    await exec('find /var/ecomgear/backups -type f -mtime +30 -delete');
  }

  private async findDistDirs(): Promise<string[]> {
    const { stdout } = await execAsync(`find ${this.projectsPath} -type d -name "dist"`);
    return stdout.split('\n').filter(Boolean);
  }

  private async getDiskStats() {
    const { stdout } = await execAsync("df -h /var/ecomgear | tail -1");
    const parts = stdout.trim().split(/\s+/);

    return {
      total: parts[1],
      used: parts[2],
      available: parts[3],
      usagePercent: parseInt(parts[4])
    };
  }
}
```

---

## 13. Monitoring & Logging

### 13.1 Logging Strategy
```typescript
// Winston logger configuration
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'ecomgear-api' },
  transports: [
    // Error logs
    new DailyRotateFile({
      filename: '/var/ecomgear/logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '14d'
    }),

    // Combined logs
    new DailyRotateFile({
      filename: '/var/ecomgear/logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d'
    }),

    // Console output (development)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Request logger middleware
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;

    logger.info('HTTP Request', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration,
      userId: req.user?.id,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
  });

  next();
}
```

### 13.2 Error Tracking
```typescript
// Sentry integration
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1
});

// Error handling middleware
export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  logger.error('Application error', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    userId: req.user?.id
  });

  // Send to Sentry
  Sentry.captureException(error, {
    user: { id: req.user?.id, email: req.user?.email },
    extra: {
      url: req.url,
      method: req.method,
      body: req.body
    }
  });

  // Save to database
  await supabase.from('error_logs').insert({
    user_id: req.user?.id,
    error_type: error.name,
    error_message: error.message,
    stack_trace: error.stack,
    context: {
      url: req.url,
      method: req.method,
      body: req.body
    },
    severity: this.classifyErrorSeverity(error)
  });

  // Response
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.id
    });
  } else {
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
}

function classifyErrorSeverity(error: Error): string {
  if (error.message.includes('ENOSPC')) return 'critical';
  if (error.message.includes('database')) return 'high';
  if (error.message.includes('timeout')) return 'medium';
  return 'low';
}
```

### 13.3 Metrics Collection
```typescript
// Prometheus metrics
import promClient from 'prom-client';

const register = new promClient.Registry();

// Default metrics
promClient.collectDefaultMetrics({ register });

// Custom metrics
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

const aiGenerationCounter = new promClient.Counter({
  name: 'ai_generations_total',
  help: 'Total number of AI code generations',
  labelNames: ['status', 'user_id'],
  registers: [register]
});

const previewSessionsGauge = new promClient.Gauge({
  name: 'preview_sessions_active',
  help: 'Number of active preview sessions',
  registers: [register]
});

const diskUsageGauge = new promClient.Gauge({
  name: 'disk_usage_percent',
  help: 'Disk usage percentage',
  registers: [register]
});

// Metrics endpoint
router.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Update metrics periodically
setInterval(async () => {
  // Update active preview sessions
  const { count } = await supabase
    .from('preview_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'running');

  previewSessionsGauge.set(count || 0);

  // Update disk usage
  const diskStats = await getDiskStats();
  diskUsageGauge.set(diskStats.usagePercent);

}, 30000); // Every 30 seconds
```

### 13.4 Health Check Endpoints
```typescript
// Health check routes
router.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {}
  };

  try {
    // Check database
    health.checks.database = await checkDatabase();

    // Check Redis
    health.checks.redis = await checkRedis();

    // Check Docker
    health.checks.docker = await checkDocker();

    // Check disk space
    health.checks.diskSpace = await checkDiskSpace();

    // Determine overall status
    const allHealthy = Object.values(health.checks).every(
      (check: any) => check.status === 'healthy'
    );

    health.status = allHealthy ? 'healthy' : 'degraded';

    res.status(allHealthy ? 200 : 503).json(health);

  } catch (error) {
    health.status = 'unhealthy';
    health.error = error.message;
    res.status(503).json(health);
  }
});

async function checkDatabase() {
  try {
    const { error } = await supabase.from('projects').select('id').limit(1);
    
    return {
      status: error ? 'unhealthy' : 'healthy',
      message: error?.message
    };
  } catch (error) {
    return { status: 'unhealthy', message: error.message };
  }
}

async function checkRedis() {
  try {
    await redis.ping();
    return { status: 'healthy' };
  } catch (error) {
    return { status: 'unhealthy', message: error.message };
  }
}

async function checkDocker() {
  try {
    const response = await axios.get('http://localhost:9000/status');
    return {
      status: 'healthy',
      activePreviews: response.data.activeProjects
    };
  } catch (error) {
    return { status: 'unhealthy', message: error.message };
  }
}

async function checkDiskSpace() {
  try {
    const stats = await getDiskStats();
    const healthy = stats.usagePercent < 90;
    
    return {
      status: healthy ? 'healthy' : 'warning',
      usagePercent: stats.usagePercent,
      available: stats.available
    };
  } catch (error) {
    return { status: 'unhealthy', message: error.message };
  }
}
```

---

## 14. Deployment Strategy

### 14.1 Environment Configuration
```bash
# .env.production
NODE_ENV=production

# Database
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-key

# Anthropic AI
ANTHROPIC_API_KEY=sk-ant-your-key

# Redis
REDIS_URL=redis://localhost:6379

# Server
PORT=5000
API_BASE_URL=https://api.ecomgear.com
PREVIEW_BASE_URL=https://preview.ecomgear.com

# Security
JWT_SECRET=your-super-secret-key
CORS_ORIGIN=https://ecomgear.com

# Logging
LOG_LEVEL=info
SENTRY_DSN=https://your-sentry-dsn

# Resource Limits
MAX_CONCURRENT_PREVIEWS=50
PREVIEW_IDLE_TIMEOUT_MINUTES=15
MAX_FILE_SIZE_MB=10
MAX_STORAGE_PER_USER_GB=10

# Docker
DOCKER_MANAGER_URL=http://localhost:9000
```

### 14.2 Deployment Steps
```bash
#!/bin/bash
# deploy.sh

set -e

echo "🚀 Starting deployment..."

# 1. Pull latest code
git pull origin main

# 2. Install dependencies
cd /var/ecomgear/server
npm install --production

# 3. Build TypeScript
npm run build

# 4. Run database migrations
npm run migrate

# 5. Restart services
pm2 restart ecomgear-api

# 6. Rebuild Docker container
cd /var/ecomgear/docker
docker-compose build
docker-compose up -d

# 7. Reload nginx
sudo nginx -t && sudo nginx -s reload

# 8. Health check
sleep 5
curl -f http://localhost:5000/health || exit 1

echo "✅ Deployment complete!"
```

### 14.3 Zero-Downtime Deployment
```bash
#!/bin/bash
# rolling-deploy.sh

# 1. Start new instance
pm2 start ecosystem.config.js --only ecomgear-api-new

# 2. Wait for health check
for i in {1..30}; do
  if curl -f http://localhost:5001/health; then
    echo "New instance healthy"
    break
  fi
  sleep 2
done

# 3. Switch nginx upstream
cat > /etc/nginx/conf.d/upstream.conf << EOF
upstream api_server {
  server localhost:5001 weight=10;
  server localhost:5000 weight=1;
}
EOF

nginx -s reload

# 4. Wait for connections to drain
sleep 30

# 5. Stop old instance
pm2 stop ecomgear-api

# 6. Switch nginx fully to new instance
cat > /etc/nginx/conf.d/upstream.conf << EOF
upstream api_server {
  server localhost:5001;
}
EOF

nginx -s reload

# 7. Rename instances
pm2 delete ecomgear-api
pm2 restart ecomgear-api-new --name ecomgear-api

echo "Zero-downtime deployment complete!"
```

### 14.4 PM2 Configuration
```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'ecomgear-api',
      script: './dist/index.js',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 5000
      },
      error_file: '/var/ecomgear/logs/pm2-error.log',
      out_file: '/var/ecomgear/logs/pm2-out.log',
      merge_logs: true,
      max_memory_restart: '1G',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'cleanup-service',
      script: './dist/services/cleanup.service.js',
      instances: 1,
      cron_restart: '0 */6 * * *', // Every 6 hours
      autorestart: false
    }
  ]
};
```

---

## 15. Scaling Considerations

### 15.1 Horizontal Scaling Strategy