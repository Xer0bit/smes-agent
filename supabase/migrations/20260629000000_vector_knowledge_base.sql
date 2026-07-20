-- ─── Vector Knowledge Base ────────────────────────────────────────────────────
-- Enables semantic file retrieval and import graph for the AI agent.
-- Requires pgvector extension (available on all Supabase projects).

-- pgvector extension
create extension if not exists vector;

-- ─── File Embeddings ─────────────────────────────────────────────────────────

create table if not exists project_file_embeddings (
  id           uuid        primary key default gen_random_uuid(),
  project_id   uuid        not null references projects(id) on delete cascade,
  file_path    text        not null,
  content_hash text        not null,   -- md5; skip re-embedding if unchanged
  embedding    vector(768),             -- Google text-embedding-004 dims
  file_size    int,
  updated_at   timestamptz default now(),
  unique(project_id, file_path)
);

-- HNSW index   10x faster than IVFFlat for < 1M vectors, no training needed
create index if not exists idx_file_embeddings_hnsw
  on project_file_embeddings
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ─── Import Graph ────────────────────────────────────────────────────────────

create table if not exists project_file_graph (
  id          uuid        primary key default gen_random_uuid(),
  project_id  uuid        not null references projects(id) on delete cascade,
  file_path   text        not null,
  imports     text[]      default '{}',    -- files this file imports (relative paths)
  exports     text[]      default '{}',    -- named symbols exported
  updated_at  timestamptz default now(),
  unique(project_id, file_path)
);

create index if not exists idx_file_graph_project
  on project_file_graph(project_id, file_path);

-- GIN index for fast array overlap queries (getDirectDependents)
create index if not exists idx_file_graph_imports_gin
  on project_file_graph using gin(imports);

-- ─── RPC: cosine similarity search ──────────────────────────────────────────
-- Called by vectorStore.ts searchSimilarFiles()

create or replace function match_file_embeddings(
  p_project_id  uuid,
  p_embedding   vector(768),
  p_match_count int default 5
)
returns table (
  file_path  text,
  similarity float
)
language sql stable
as $$
  select
    file_path,
    1 - (embedding <=> p_embedding) as similarity
  from project_file_embeddings
  where project_id = p_project_id
    and embedding is not null
  order by embedding <=> p_embedding
  limit p_match_count;
$$;

-- ─── RLS ─────────────────────────────────────────────────────────────────────

alter table project_file_embeddings enable row level security;
alter table project_file_graph       enable row level security;

-- Service role has full access (server-side only)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'project_file_embeddings' and policyname = 'service_role_embeddings'
  ) then
    create policy "service_role_embeddings"
      on project_file_embeddings for all
      using (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
    where tablename = 'project_file_graph' and policyname = 'service_role_graph'
  ) then
    create policy "service_role_graph"
      on project_file_graph for all
      using (auth.role() = 'service_role');
  end if;
end $$;
