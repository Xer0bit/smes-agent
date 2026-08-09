// Runtime error reporter: catches window errors + unhandled rejections and
// POSTs them back to the preview service so they appear in the /status
// endpoint and trigger the Repair overlay (same as build errors).
// The project-id placeholder below is swapped for the real id at injection
// time (server.js). Do NOT write the placeholder token in comments: replace()
// with a string only substitutes the first occurrence, and a comment match
// stole the substitution from the fetch URL (live bug, 2026-07-21).
(function () {
  var _reported = false;
  function report(msg, src, line) {
    if (_reported) return; _reported = true;
    try {
      fetch('/preview/__PROJECT_ID__/runtime-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: String(msg), source: String(src || ''), line: line || 0 })
      });
    } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    // Skip resource load errors (images, fonts, etc.): e.error is null and e.filename is empty
    if (!e.error && !e.filename) return;
    report((e.error ? e.error.message : e.message) || String(e), e.filename, e.lineno);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var msg = e.reason ? (e.reason.message || String(e.reason)) : 'Unhandled promise rejection';
    report(msg, '', 0);
  }, true);
})();
