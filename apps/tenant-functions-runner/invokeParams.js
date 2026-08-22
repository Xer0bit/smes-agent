/**
 * Resolves the params object an edge function receives from an invoke request
 * body. Lives in its own module so server.js and its test share ONE definition
 * -- a test that re-implements this rule would keep passing while the server
 * drifted away from it.
 *
 * Documented envelope (app-builder.prompt.ts) is {"params": {...}}. Generated
 * frontends have shipped POSTing the payload FLAT instead --
 * {"action":"fetchCards"} rather than {"params":{"action":"fetchCards"}} --
 * which arrived as params={} and made every field `undefined` inside the
 * function. Verified live on CardPro (2026-08-22): a router function answered
 * "Unknown action: undefined", the runner wrapped that as HTTP 200
 * {result:{error:...}}, the frontend's top-level `error` check passed, and it
 * then called .map() on the error object -- surfacing as "data.map is not a
 * function" with the real cause nowhere in sight.
 *
 * The documented key always wins, so a correct caller is never shadowed, and
 * an explicit {"params":{}} stays empty rather than falling through to the
 * whole body.
 */
export function resolveInvokeParams(reqBody) {
  const body = reqBody ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) return {};
  return body.params ?? body;
}
