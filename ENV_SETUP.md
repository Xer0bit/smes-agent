# Environment Configuration Guide

## Quick Start

### Local Development (Recommended for feature work)
```bash
# Copy local env (already configured)
cp .env.local .env

# Start services
supabase start                    # Terminal 1 - local DB
cd server && npm run dev          # Terminal 2 - backend (localhost:5001)
npm run dev                       # Terminal 3 - frontend (localhost:8080)
```

**What you get:**
- ✅ Local Supabase (http://127.0.0.1:54321) - all your project data stored locally
- ✅ Production LLM services (gen.ecomgear.dev, agent.ecomgear.dev)
- ✅ Production Hosting service (hosting.ecomgear.app)
- ✅ Production Preview service (preview.ecomgear.app)
- ✅ Fast iteration - no auth issues, data persists locally

### Production Environment 
```bash
# Build and deploy (never run locally)
npm run build
./scripts/force-deploy.sh vps1   # Frontend
./scripts/force-deploy.sh vps3   # Backend
```

---

## Environment Files

| File | Use Case | Supabase | LLM/Hosting |
|------|----------|----------|-------------|
| `.env.local` | Local dev | Local (127.0.0.1:54321) | **Production** |
| `.env.production` | Build for prod | Production (api.ecomgear.dev) | Production |
| `.env.staging.local` | Staging test | Local | Local (isolated ports) |

---

## How to Switch Environments

### Switch to Local Dev
```bash
cp .env.local .env
# Restart frontend server (Vite will reload with new env vars)
```

### Switch to Production Build
```bash
cp .env.production .env
npm run build  # Builds with production endpoints
```

---

## Deploy Process

### Local → Production Workflow
1. **Develop locally** using `.env.local`
2. **Test features** in http://localhost:8080
3. **Commit code** to git
4. **Build for production**:
   ```bash
   cp .env.production .env
   npm run build
   ```
5. **Deploy** using scripts:
   ```bash
   ./scripts/force-deploy.sh vps1   # Frontend + migrations
   ./scripts/force-deploy.sh vps3   # Backend
   ```

---

## Key Endpoints

### Local Dev (.env.local)
```
Frontend:        http://localhost:8080
Supabase API:    http://127.0.0.1:54321
Studio:          http://127.0.0.1:54323
Backend:         http://localhost:5001 (not exposed - local only)
LLM Service:     https://gen.ecomgear.dev (production)
Hosting:         https://hosting.ecomgear.app (production)
```

### Production (.env.production)
```
Frontend:        https://www.ecomgear.dev
Supabase API:    https://api.ecomgear.dev
Backend:         https://gen.ecomgear.dev (VPS3)
LLM Service:     https://gen.ecomgear.dev
Hosting:         https://hosting.ecomgear.app
```

---

## Troubleshooting

**Q: "Project not found" errors**
- A: Make sure you're using `.env.local` with local Supabase
- Run: `supabase start`

**Q: "401 Unauthorized" on production endpoints**
- A: Local Supabase tokens don't work with production APIs
- This is normal - use local endpoints or switch to production build

**Q: Want to test production Supabase locally?**
- A: Manually edit `.env.local` and set:
  ```
  VITE_SUPABASE_URL="https://api.ecomgear.dev"
  VITE_API_URL="https://api.ecomgear.dev"
  ```
  But you'll need valid auth tokens (user login required)

---

## Next Steps

- ✅ `.env.local` - ready for local development
- ✅ Production services configured
- 📝 To make changes to production, edit `.env.production` as needed
- 🚀 Deploy via `./scripts/force-deploy.sh`
