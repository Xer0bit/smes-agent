// ─── XML parsers ──────────────────────────────────────────────────────────────

export interface OperationStore {
  filesToWrite: Array<{ path: string; content: string }>;
  filesEdited: string[];
  filesToDelete: string[];
  renames: Array<{ from: string; to: string }>;
  dependencies: string[];
}

export function parseXmlOperation(xml: string, store: OperationStore): void {
  // SMEsAgent-edit (must check before SMEsAgent-write to avoid partial match)
  const editMatch = /<SMEsAgent-edit\s+path="([^"]+)"/.exec(xml);
  if (editMatch) {
    if (!store.filesEdited.includes(editMatch[1])) store.filesEdited.push(editMatch[1]);
    return;
  }
  // SMEsAgent-write
  const writeMatch = /<SMEsAgent-write\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/SMEsAgent-write>/.exec(xml);
  if (writeMatch) {
    const p = writeMatch[1];
    const c = writeMatch[2].trim();
    const existing = store.filesToWrite.findIndex((f) => f.path === p);
    if (existing >= 0) store.filesToWrite[existing].content = c;
    else store.filesToWrite.push({ path: p, content: c });
    return;
  }
  // SMEsAgent-delete
  const deleteMatch = /<SMEsAgent-delete\s+path="([^"]+)"/.exec(xml);
  if (deleteMatch && !store.filesToDelete.includes(deleteMatch[1])) {
    store.filesToDelete.push(deleteMatch[1]);
    return;
  }
  // SMEsAgent-rename
  const renameMatch = /<SMEsAgent-rename\s+from="([^"]+)"\s+to="([^"]+)"/.exec(xml);
  if (renameMatch) {
    store.renames.push({ from: renameMatch[1], to: renameMatch[2] });
    return;
  }
  // SMEsAgent-add-dependency
  const depMatch = /<SMEsAgent-add-dependency\s+packages="([^"]+)"/.exec(xml);
  if (depMatch) {
    depMatch[1].split(/\s+/).filter(Boolean).forEach((d) => {
      if (!store.dependencies.includes(d)) store.dependencies.push(d);
    });
  }
}

export function parseXmlResponse(text: string, store: OperationStore): void {
  // Run write regex globally
  const writeRe = /<SMEsAgent-write\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/SMEsAgent-write>/g;
  let m: RegExpExecArray | null;
  while ((m = writeRe.exec(text)) !== null) {
    const p = m[1], c = m[2].trim();
    const existing = store.filesToWrite.findIndex((f) => f.path === p);
    if (existing >= 0) store.filesToWrite[existing].content = c;
    else store.filesToWrite.push({ path: p, content: c });
  }

  const deleteRe = /<SMEsAgent-delete\s+path="([^"]+)"/g;
  while ((m = deleteRe.exec(text)) !== null) {
    if (!store.filesToDelete.includes(m[1])) store.filesToDelete.push(m[1]);
  }

  const renameRe = /<SMEsAgent-rename\s+from="([^"]+)"\s+to="([^"]+)"/g;
  while ((m = renameRe.exec(text)) !== null) {
    store.renames.push({ from: m[1], to: m[2] });
  }

  const depRe = /<SMEsAgent-add-dependency\s+packages="([^"]+)"/g;
  while ((m = depRe.exec(text)) !== null) {
    m[1].split(/\s+/).filter(Boolean).forEach((d) => {
      if (!store.dependencies.includes(d)) store.dependencies.push(d);
    });
  }
}
