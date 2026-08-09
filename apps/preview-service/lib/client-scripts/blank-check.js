(function () {
  var _blankReported = false;
  var _hadContent = false; // true once real content was seen
  var _reportTimer = null;

  // Walk the DOM tree up to 'depth' levels looking for an element with
  // real rendered dimensions. Returns true when visible content is found.
  function hasRealContent(el, depth) {
    if (!el || depth <= 0) return false;
    var s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') < 0.05) return false;
    var r = el.getBoundingClientRect();
    // Element occupies at least 4x4 px of screen real estate   real content
    if (r.width > 4 && r.height > 4) return true;
    for (var i = 0; i < el.children.length; i++) {
      if (hasRealContent(el.children[i], depth - 1)) return true;
    }
    return false;
  }

  function reportBlank() {
    if (_blankReported) return;
    _blankReported = true;
    window.parent.postMessage({ type: 'PREVIEW_BLANK' }, '*');
  }

  // A blank reading on the FIRST check is only a suspicion, not a verdict   a
  // cold preview server (Vite still transforming/optimizing deps after the
  // project was idle) can easily take longer than a few seconds to paint
  // anything, and that used to get misreported as a real crash. Only report
  // once a check is still blank on the CONFIRM pass, several seconds later.
  function checkBlank(confirm) {
    if (_blankReported) return;
    try {
      var root = document.getElementById('root') || document.getElementById('app');
      var target = root || document.body;
      var isBlank = (target.children.length === 0) || !hasRealContent(target, 6);
      if (isBlank) {
        if (confirm) {
          reportBlank();
        } else {
          scheduleCheck(7000, true);
        }
      } else {
        _hadContent = true; // app has rendered at least once   resets observer guard
      }
    } catch (e) {}
  }

  function scheduleCheck(delay, confirm) {
    if (_blankReported) return;
    clearTimeout(_reportTimer);
    _reportTimer = setTimeout(function () { checkBlank(confirm); }, delay);
  }

  // Initial suspicion check at 5s (soft   just schedules a confirm pass if
  // still blank), confirmed at +7s (12s total) before actually flagging.
  window.addEventListener('load', function () {
    scheduleCheck(5000, false);
  });

  // Re-check after any route change (React Router / hash nav / back-forward).
  // The app already proved it can render once, so a shorter confirm window
  // is fine here   this path is for genuine post-navigation crashes.
  window.addEventListener('hashchange', function () { if (!_blankReported) scheduleCheck(1500, true); });
  window.addEventListener('popstate', function () { if (!_blankReported) scheduleCheck(1500, true); });

  // Watch for the React root being emptied AFTER it previously had content.
  // This catches: HMR update failures, React crashes, route components that
  // unmount everything, and Vite's dev-server error overlay replacing the app.
  try {
    var root = document.getElementById('root') || document.getElementById('app') || document.body;
    var observer = new MutationObserver(function () {
      if (_blankReported || !_hadContent) return;
      // Debounce: give React 2s to re-render after the DOM change before flagging
      scheduleCheck(2000, true);
    });
    observer.observe(root, { childList: true, subtree: false });
  } catch (e) {}
})();
