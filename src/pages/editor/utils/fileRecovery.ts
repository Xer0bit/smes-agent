export function extractInvalidSourceFiles(errorMessage?: string): string[] {
  if (!errorMessage) return [];

  const matches = errorMessage.matchAll(/([A-Za-z0-9_./-]+\.(?:tsx|ts|jsx|js)):\d+:\d+/g);
  const files = new Set<string>();

  for (const match of matches) {
    const normalized = (match[1] || '').replace(/^\//, '');
    if (normalized) files.add(normalized);
  }

  return Array.from(files);
}

export function buildRetryFilesWithFallback(
  candidateFiles: Array<{ path: string; content: string }>,
  previousFilesMap: Map<string, { path: string; content: string }>,
  invalidFilePaths: string[]
) {
  if (invalidFilePaths.length === 0) return null;

  const invalidSet = new Set(invalidFilePaths.map(p => p.replace(/^\//, '')));
  const previousByPath = new Map<string, { path: string; content: string }>();

  previousFilesMap.forEach((value, key) => {
    previousByPath.set(key.replace(/^\//, ''), { path: value.path, content: value.content });
  });

  const criticalFiles = new Set(['index.html', 'src/main.tsx', 'src/App.tsx']);
  const missingFallbackPaths: string[] = [];
  const invalidCriticalWithoutFallback: string[] = [];

  let replaced = 0;
  let removed = 0;
  const files: Array<{ path: string; content: string }> = [];

  for (const file of candidateFiles) {
    const normalizedPath = file.path.replace(/^\//, '');
    if (!invalidSet.has(normalizedPath)) {
      files.push(file);
      continue;
    }

    const fallback = previousByPath.get(normalizedPath);
    if (fallback) {
      files.push({ path: file.path, content: fallback.content });
      replaced++;
    } else {
      // No previous version   keep the file as-is and let the preview service
      // handle it. Never replace with a generated fallback placeholder.
      files.push(file);
      missingFallbackPaths.push(normalizedPath);
      if (criticalFiles.has(normalizedPath)) {
        invalidCriticalWithoutFallback.push(normalizedPath);
      }
      removed++;
    }
  }

  const safeToRetry = removed === 0 && invalidCriticalWithoutFallback.length === 0;
  const reason = !safeToRetry
    ? (
      invalidCriticalWithoutFallback.length > 0
        ? `Critical file(s) invalid without fallback: ${invalidCriticalWithoutFallback.join(', ')}`
        : `Invalid file(s) have no fallback: ${missingFallbackPaths.join(', ')}`
    )
    : undefined;

  return { files, replaced, removed, safeToRetry, reason };
}

export function buildSafeFilesAfterValidation(
  candidateFiles: Array<{ path: string; content: string }>,
  previousFilesMap: Map<string, { path: string; content: string }>,
  validationErrors: Array<{ file: string; severity: 'error' | 'warning' }>
) {
  const blockingFiles = new Set(
    validationErrors
      .filter((error) => error.severity === 'error')
      .map((error) => (error.file || '').replace(/^\//, ''))
      .filter(Boolean)
  );

  if (blockingFiles.size === 0) {
    return {
      files: candidateFiles,
      rolledBack: 0,
      removed: 0,
      unresolved: [] as string[],
      blocking: [] as string[],
    };
  }

  const previousByPath = new Map<string, { path: string; content: string }>();
  previousFilesMap.forEach((value, key) => {
    previousByPath.set(key.replace(/^\//, ''), { path: value.path, content: value.content });
  });

  let rolledBack = 0;
  let removed = 0;
  const unresolved: string[] = [];
  const files: Array<{ path: string; content: string }> = [];

  for (const file of candidateFiles) {
    const normalizedPath = file.path.replace(/^\//, '');
    if (!blockingFiles.has(normalizedPath)) {
      files.push(file);
      continue;
    }

    const fallback = previousByPath.get(normalizedPath);
    if (fallback) {
      files.push({ path: file.path, content: fallback.content });
      rolledBack++;
    } else {
      // No previous version available   keep the current file as-is and let
      // the preview service handle validation. Never replace with a generated
      // "temporarily recovered" placeholder   that confuses users.
      files.push(file);
      removed++;
      unresolved.push(normalizedPath);
    }
  }

  return {
    files,
    rolledBack,
    removed,
    unresolved,
    blocking: Array.from(blockingFiles),
  };
}
