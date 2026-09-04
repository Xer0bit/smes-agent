/**
 * What the browser gets in the 'done' event, as opposed to what the preview
 * service gets in the fullSync push.
 *
 * Both were the same array (`mergedWrites`) purely by accident of construction.
 * That array base64-encodes every binary asset so images survive the JSON sync
 * payload to preview-service -- necessary there, pure waste to the browser.
 * Measured on a real project 2026-08-24: 194 files / 19.8 MB on disk, of which
 * 18.1 MB is .jpg/.png/.pdf and only ~1.2 MB is actual source. base64 inflates
 * the binary share by ~4/3, so every agent run streamed roughly 24 MB of
 * encoded JPEGs to the browser -- on a one-line edit, and again on every retry.
 *
 * The browser cannot use them. It never renders project source (the preview is
 * an iframe served by the preview host, which already has the assets on disk),
 * and nothing on the client decodes BINARY_SENTINEL.
 *
 * Dropping them from a payload the client may later fullSync back is safe, and
 * safe by construction rather than by luck: preview-service refuses to prune
 * binary-extension files unconditionally (materialize.js NEVER_PRUNE_EXT_RE,
 * added after "images disappear on reload" was traced to exactly this class of
 * incomplete push). That regex and BINARY_EXTS_SET here cover the same
 * extensions, so anything stripped here is something the receiving end will
 * never delete. Entries are matched on the sentinel AND the extension, so a
 * file outside that set is never dropped even if it somehow carries one.
 */

const BINARY_SENTINEL = '__SMEsAgent_BIN64__';

/** Mirrors preview-service materialize.js NEVER_PRUNE_EXT_RE. Keep in sync. */
const NEVER_PRUNED_EXT_RE = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|otf|mp4|mp3|pdf|zip|svg)$/i;

export interface FilePayloadEntry {
  path: string;
  content: string;
}

/**
 * Strip base64 binary blobs from a file list bound for the browser.
 *
 * Text files pass through untouched: the editor's preview fallback builds from
 * them when its own workspace state is empty, so thinning those would change
 * behaviour rather than just bandwidth.
 */
export function stripBinariesForClient<T extends FilePayloadEntry>(files: readonly T[]): T[] {
  return files.filter(
    (f) => !(typeof f.content === 'string' && f.content.startsWith(BINARY_SENTINEL) && NEVER_PRUNED_EXT_RE.test(f.path)),
  );
}

/** Bytes that would have been sent, for logging the saving rather than assuming it. */
export function payloadBytes(files: readonly FilePayloadEntry[]): number {
  let n = 0;
  for (const f of files) n += f.path.length + (f.content?.length ?? 0);
  return n;
}
