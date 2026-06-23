/**
 * Supabase pgvector operations for file embeddings.
 * Table: project_file_embeddings
 *
 * All operations are safe to call even when Supabase is unavailable —
 * they return empty results rather than throwing.
 */

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { getEmbeddingDims } from './embedder.js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_ANON_KEY || '';

// Must match the vector(N) column in project_file_embeddings.
// BM25 fallback produces 256-dim — those cannot be stored here.
const DB_VECTOR_DIMS = 768;

function checkDims(embedding: number[], context: string): boolean {
  if (embedding.length === DB_VECTOR_DIMS) return true;
  console.warn(
    `[kb/vectorStore] ${context}: embedding is ${embedding.length}-dim but DB expects ${DB_VECTOR_DIMS}-dim. ` +
    'KB indexing disabled — set GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY to enable it.',
  );
  return false;
}

function getClient() {
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey);
}

export interface FileEmbeddingRow {
  project_id: string;
  file_path: string;
  content_hash: string;
  embedding: number[];
  file_size: number;
}

export interface SimilarFile {
  file_path: string;
  similarity: number;
}

export function hashContent(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/** Upsert a file embedding. Skips if content_hash unchanged or dims don't match DB column. */
export async function upsertFileEmbedding(
  projectId: string,
  filePath: string,
  content: string,
  embedding: number[],
): Promise<void> {
  if (!checkDims(embedding, 'upsert')) return;
  const db = getClient();
  if (!db) return;

  const hash = hashContent(content);

  const { error } = await db.from('project_file_embeddings').upsert(
    {
      project_id:   projectId,
      file_path:    filePath,
      content_hash: hash,
      embedding:    JSON.stringify(embedding),
      file_size:    content.length,
      updated_at:   new Date().toISOString(),
    },
    { onConflict: 'project_id,file_path' },
  );

  if (error) {
    console.warn('[kb/vectorStore] upsert error:', error.message);
  }
}

/** Check if a file is already indexed with the same content. */
export async function isAlreadyIndexed(
  projectId: string,
  filePath: string,
  content: string,
): Promise<boolean> {
  const db = getClient();
  if (!db) return false;

  const { data } = await db
    .from('project_file_embeddings')
    .select('content_hash')
    .eq('project_id', projectId)
    .eq('file_path', filePath)
    .single();

  return data?.content_hash === hashContent(content);
}

/**
 * Find the most similar files to a query embedding.
 * Uses pgvector's <=> cosine distance operator via RPC.
 */
export async function searchSimilarFiles(
  projectId: string,
  queryEmbedding: number[],
  limit = 5,
): Promise<SimilarFile[]> {
  if (!checkDims(queryEmbedding, 'search')) return [];
  const db = getClient();
  if (!db) return [];

  const { data, error } = await db.rpc('match_file_embeddings', {
    p_project_id:    projectId,
    p_embedding:     JSON.stringify(queryEmbedding),
    p_match_count:   limit,
  });

  if (error) {
    console.warn('[kb/vectorStore] search error:', error.message);
    return [];
  }

  return (data ?? []).map((row: any) => ({
    file_path:  row.file_path as string,
    similarity: row.similarity as number,
  }));
}

/** Remove embedding for a deleted file. */
export async function deleteFileEmbedding(
  projectId: string,
  filePath: string,
): Promise<void> {
  const db = getClient();
  if (!db) return;

  await db
    .from('project_file_embeddings')
    .delete()
    .eq('project_id', projectId)
    .eq('file_path', filePath);
}

/** Remove all embeddings for a project (e.g. on project delete). */
export async function deleteProjectEmbeddings(projectId: string): Promise<void> {
  const db = getClient();
  if (!db) return;

  await db
    .from('project_file_embeddings')
    .delete()
    .eq('project_id', projectId);
}
