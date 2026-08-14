-- ─── Agent Semantic Cache ────────────────────────────────────────────────────
-- Caches full file-snapshot results from fresh-project first-build runs,
-- keyed by prompt embedding. A near-duplicate prompt (cosine similarity
-- above threshold) on another fresh, empty project can reuse the cached
-- result instead of paying for a full generation run.
--
-- Scoped to the fresh-empty-project/first-message/build-tier path only
-- (agentSemanticCache.ts's call sites in agentLoopService.ts) -- that's the
-- one context where reusing another project's cached output is safe: there
-- are no existing files to conflict with or silently overwrite.
--
-- Same vector convention as 20260629000000_vector_knowledge_base.sql:
-- vector(768) (this project's active embedding provider dimension, via
-- embedder.ts), HNSW cosine index, service-role-only RLS.

create table if not exists agent_semantic_cache (
  id            uuid        primary key default gen_random_uuid(),
  prompt_text   text        not null,
  embedding     vector(768),
  framework     text        not null default 'react',
  file_snapshot jsonb       not null,
  hit_count     int         not null default 0,
  last_hit_at   timestamptz,
  created_at    timestamptz default now()
);

create index if not exists idx_semantic_cache_hnsw
  on agent_semantic_cache
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists idx_semantic_cache_framework
  on agent_semantic_cache(framework);

-- ─── RPC: cosine similarity search ──────────────────────────────────────────
-- Called by agentSemanticCache.ts checkSemanticCache()

create or replace function match_semantic_cache(
  query_embedding      vector(768),
  similarity_threshold float,
  match_count          int default 1,
  p_framework          text default 'react'
)
returns table (
  id            uuid,
  prompt_text   text,
  file_snapshot jsonb,
  hit_count     int,
  similarity    float
)
language sql stable
as $$
  select
    id,
    prompt_text,
    file_snapshot,
    hit_count,
    1 - (embedding <=> query_embedding) as similarity
  from agent_semantic_cache
  where framework = p_framework
    and embedding is not null
    and 1 - (embedding <=> query_embedding) > similarity_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ─── RLS ─────────────────────────────────────────────────────────────────────

alter table agent_semantic_cache enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'agent_semantic_cache' and policyname = 'service_role_semantic_cache'
  ) then
    create policy "service_role_semantic_cache"
      on agent_semantic_cache for all
      using (auth.role() = 'service_role');
  end if;
end $$;
