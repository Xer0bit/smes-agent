export { indexFile, indexFiles, removeFileIndex, retrieveRelevantFiles, scoreFilesLocally } from './retrieval.js';
export { embedText, embedTexts, cosineSim, getProvider, getEmbeddingDims } from './embedder.js';
export { upsertFileEmbedding, searchSimilarFiles, deleteFileEmbedding, deleteProjectEmbeddings } from './vectorStore.js';
export { parseImports, parseExports, upsertFileGraph, getDirectImports, getDirectDependents } from './graphStore.js';
export type { WorkspaceFile, RetrievedFile, RetrievalOptions } from './retrieval.js';
export type { SimilarFile } from './vectorStore.js';
export type { EmbeddingProvider } from './embedder.js';
