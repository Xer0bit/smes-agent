// Patches history.pushState/replaceState and listens for hash/pop events so
// React Router navigation is reported back to the parent frame.
(function () {
  function sendNav() {
    try {
      // Apps use HashRouter   the route lives in the hash fragment, not the pathname.
      // Send only the route portion (e.g. "/post-gig") so the parent does not
      // re-embed the full /preview/{id}/ path into a URL hash, causing duplication.
      var hash = window.location.hash;
      var routePath = hash ? hash.replace(/^#/, '') : '/';
      if (!routePath || routePath === '') routePath = '/';
      window.parent.postMessage({ type: 'navigation', pathname: routePath }, '*');
    } catch (e) {}
  }
  // Patch pushState / replaceState so React Router link clicks are captured
  function patchHistory(method) {
    var original = window.history[method];
    window.history[method] = function () {
      original.apply(this, arguments);
      sendNav();
    };
  }
  patchHistory('pushState');
  patchHistory('replaceState');
  window.addEventListener('hashchange', sendNav);
  window.addEventListener('popstate', sendNav);
  // Send initial route after app has mounted
  setTimeout(sendNav, 300);

  // Back/Forward toolbar buttons live in the parent (Editor.tsx) and can't
  // call history.back()/forward() on this cross-origin iframe directly, so
  // they ask via postMessage instead   history.go() runs same-origin here,
  // same as every other parent<->preview signal (inspect mode, etc).
  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'ecg-nav-go' && typeof event.data.delta === 'number') {
      window.history.go(event.data.delta);
    }
  });
})();
