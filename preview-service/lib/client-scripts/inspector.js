// Click-to-select inspector ("Magic Cursor"). Activated/deactivated via
// postMessage from the parent (MultiDevicePreview). When active, clicking an
// element resolves it to its real JSX source location (file/line/column) via
// the React Fiber tree -- not just a CSS selector -- and posts it back so the
// chat can give the agent an exact address to edit, instead of asking it to
// re-locate the element from a natural-language description. Supports
// multi-select via Cmd/Ctrl+click.
(function () {
  var _inspectActive = false;
  var _hoverOverlay = null;
  var _selected = []; // array of the enriched payloads described below
  var _badges = [];

  function clearHoverOverlay() {
    if (_hoverOverlay) { _hoverOverlay.remove(); _hoverOverlay = null; }
  }

  function clearBadges() {
    _badges.forEach(function (b) { b.remove(); });
    _badges = [];
  }

  function hoverHighlight(el) {
    if (!_hoverOverlay) {
      _hoverOverlay = document.createElement('div');
      _hoverOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:999998;border:1.5px dashed rgba(99,102,241,0.5);background:rgba(99,102,241,0.05);transition:all 80ms ease;';
      document.body.appendChild(_hoverOverlay);
    }
    var r = el.getBoundingClientRect();
    _hoverOverlay.style.left = r.left + 'px';
    _hoverOverlay.style.top = r.top + 'px';
    _hoverOverlay.style.width = r.width + 'px';
    _hoverOverlay.style.height = r.height + 'px';
  }

  function renderSelectionBadges() {
    clearBadges();
    _selected.forEach(function (item, i) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:999997;border:2px solid #6366f1;background:rgba(99,102,241,0.12);';
      var r = item.rect;
      overlay.style.left = r.x + 'px';
      overlay.style.top = r.y + 'px';
      overlay.style.width = r.width + 'px';
      overlay.style.height = r.height + 'px';

      var badge = document.createElement('div');
      badge.textContent = String(i + 1);
      badge.style.cssText = 'position:absolute;top:-9px;left:-9px;width:18px;height:18px;border-radius:9999px;background:#6366f1;color:#fff;font:600 10px/18px sans-serif;text-align:center;';
      overlay.appendChild(badge);

      document.body.appendChild(overlay);
      _badges.push(overlay);
    });
  }

  function buildSelector(el) {
    if (el.id) return '#' + el.id;
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 4) {
      var part = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        var cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) part += '.' + cls;
      }
      var parent = el.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function (c) { return c.tagName === el.tagName; });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(' > ');
  }

  // Resolves a clicked DOM node to its real JSX source location by walking
  // the React Fiber tree. Vite's React plugin runs
  // @babel/plugin-transform-react-jsx-source in dev mode, which attaches
  // __source: {fileName, lineNumber, columnNumber} to every JSX element --
  // the same mechanism React DevTools uses for "jump to source". No extra
  // build tooling needed, this just reads what's already there.
  function resolveFiberSource(domEl) {
    var fiberKey = Object.keys(domEl).find(function (k) {
      return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0;
    });
    if (!fiberKey) return null;

    var hostFiber = domEl[fiberKey];
    var hostSource = hostFiber && hostFiber._debugSource;
    if (!hostSource) return null;

    // Walk up to find the owning component (a Fiber whose type is a
    // function/class, not a plain DOM tag string) and its own JSX return's
    // source location -- comparing the two tells us whether the clicked
    // node IS the component's root return (component-level) or a nested
    // element within it (element-level).
    var fiber = hostFiber;
    var owningComponentFiber = null;
    while (fiber) {
      if (fiber.type && (typeof fiber.type === 'function' || (fiber.type.render && typeof fiber.type.render === 'function'))) {
        owningComponentFiber = fiber;
        break;
      }
      fiber = fiber.return;
    }

    var componentName = null;
    var isComponentRoot = false;
    if (owningComponentFiber) {
      componentName = owningComponentFiber.type.displayName || owningComponentFiber.type.name || null;
      // The component's own Fiber inherits _debugSource from the JSX
      // element that created it (i.e. its call site in the parent), not
      // from its own return statement -- so we compare the host node's
      // source to the FIRST child fiber's source (the component's actual
      // rendered root) to detect "this click landed on the component's
      // top-level return".
      var childFiber = owningComponentFiber.child;
      var childSource = childFiber && childFiber._debugSource;
      if (childSource && childSource.fileName === hostSource.fileName && childSource.lineNumber === hostSource.lineNumber) {
        isComponentRoot = true;
      }
    }

    return {
      file: hostSource.fileName,
      line: hostSource.lineNumber,
      column: hostSource.columnNumber,
      componentName: componentName,
      isComponentRoot: isComponentRoot,
    };
  }

  function describeElement(el) {
    var selector = buildSelector(el);
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    var source = resolveFiberSource(el);
    return {
      selector: selector,
      tagName: el.tagName.toLowerCase(),
      text: (el.innerText || '').slice(0, 100),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      style: {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize
      },
      source: source, // null if this DOM node isn't inside a dev-mode React tree we could resolve
      el: el,
    };
  }

  function postSelection() {
    try {
      window.parent.postMessage({
        type: 'ecg-multi-select-changed',
        items: _selected.map(function (item) {
          // Don't try to postMessage the raw DOM node.
          var copy = {};
          for (var k in item) if (k !== 'el') copy[k] = item[k];
          return copy;
        }),
      }, '*');
    } catch (err) {}
  }

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'ecg-inspect-mode') {
      _inspectActive = e.data.active;
      if (!_inspectActive) {
        clearHoverOverlay();
        clearBadges();
        _selected = [];
        postSelection();
      }
    }
  });

  document.addEventListener('click', function (e) {
    if (!_inspectActive) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (!el || el === document.body || el === document.documentElement) return;

    var additive = e.metaKey || e.ctrlKey;
    var item = describeElement(el);

    if (!additive) {
      _selected = [item];
    } else {
      // Nesting resolution: selecting a descendant of an already-selected
      // node is a no-op (the ancestor already covers it); selecting an
      // ancestor of an already-selected node replaces that entry (expanding
      // scope is an explicit user action).
      var alreadyCovered = _selected.some(function (s) { return s.el.contains(el); });
      if (alreadyCovered) return;
      _selected = _selected.filter(function (s) { return !el.contains(s.el); });
      _selected.push(item);
    }

    renderSelectionBadges();
    postSelection();
  }, true);

  document.addEventListener('mousemove', function (e) {
    if (!_inspectActive) return;
    var el = e.target;
    if (el && el !== document.body && el !== document.documentElement) hoverHighlight(el);
  });
})();
