// Runs inside every preview iframe. Reports the app's route to the editor and
// gives the editor's Back / Forward buttons a history that belongs to the
// preview alone.
//
// An iframe shares the browser's session history with the page around it, so
// every router pushState inside the app added an entry to the EDITOR's
// history: the browser's back button then stepped through preview pages, and
// the toolbar's history.go(-1), once the preview had no entries left of its
// own, walked the editor back to the dashboard. Now the app's pushes are
// turned into replaceState (no joint-history entry, ever) and the route stack
// lives here in memory; Back / Forward move through that stack and nowhere
// else.
(function () {
  // Installed once per document: a second copy would wrap the first and keep
  // a second, disagreeing stack.
  if (window.__ecgNav) return;
  var original = { pushState: window.history.pushState, replaceState: window.history.replaceState };
  var routes = [currentRoute()];
  var index = 0;

  function currentRoute() {
    // Apps use HashRouter: the route lives in the hash fragment.
    var hash = window.location.hash;
    var route = hash ? hash.replace(/^#/, '') : '/';
    return route || '/';
  }

  function sendNav() {
    try {
      window.parent.postMessage({
        type: 'navigation',
        pathname: currentRoute(),
        canGoBack: index > 0,
        canGoForward: index < routes.length - 1,
      }, '*');
    } catch (e) {}
  }

  function record(replace) {
    var route = currentRoute();
    if (replace) {
      routes[index] = route;
    } else if (routes[index] !== route) {
      routes = routes.slice(0, index + 1);
      routes.push(route);
      index = routes.length - 1;
    }
    sendNav();
  }

  // A router "push" becomes a replace in the real history plus a push on our stack.
  window.history.pushState = function () {
    original.replaceState.apply(this, arguments);
    record(false);
  };
  window.history.replaceState = function () {
    original.replaceState.apply(this, arguments);
    record(true);
  };
  // Direct `location.hash = ...` writes (rare) still land in the joint history;
  // at least keep the stack honest about them.
  window.addEventListener('hashchange', function () { record(false); });
  window.addEventListener('popstate', function () { record(true); });
  // Initial route once the app has mounted.
  setTimeout(sendNav, 300);

  // Back / Forward from the editor toolbar: move within OUR stack only. A
  // delta that would leave it is ignored rather than handed to history.go.
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'ecg-nav-go' || typeof data.delta !== 'number') return;
    var target = index + data.delta;
    if (target < 0 || target > routes.length - 1 || target === index) return;
    index = target;
    var url = window.location.pathname + window.location.search + '#' + routes[index];
    original.replaceState.call(window.history, window.history.state, '', url);
    // The router re-reads the location on popstate; this is a real navigation
    // to it, only its history entry is ours instead of the browser's.
    try { window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state })); }
    catch (e) { window.dispatchEvent(new Event('popstate')); }
  });

  // Exposed for tests (and the install guard above).
  window.__ecgNav = {
    routes: function () { return routes.slice(); },
    index: function () { return index; },
    reset: function () { routes = [currentRoute()]; index = 0; },
  };
})();
