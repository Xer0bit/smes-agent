// Click-to-select inspector. Activated/deactivated via postMessage from the
// parent (MultiDevicePreview). When active, clicking an element posts its
// selector + rect + tagName back so the chat can scope the next prompt to
// that element (Lovable/v0 parity).
(function () {
  var _inspectActive = false;
  var _overlay = null;

  function clearOverlay() {
    if (_overlay) { _overlay.remove(); _overlay = null; }
  }

  function highlight(el) {
    if (!_overlay) {
      _overlay = document.createElement('div');
      _overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:999999;border:2px solid #6366f1;background:rgba(99,102,241,0.12);transition:all 80ms ease;';
      document.body.appendChild(_overlay);
    }
    var r = el.getBoundingClientRect();
    _overlay.style.left = r.left + 'px';
    _overlay.style.top = r.top + 'px';
    _overlay.style.width = r.width + 'px';
    _overlay.style.height = r.height + 'px';
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

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'ecg-inspect-mode') {
      _inspectActive = e.data.active;
      if (!_inspectActive) clearOverlay();
    }
  });

  document.addEventListener('click', function (e) {
    if (!_inspectActive) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (!el || el === document.body || el === document.documentElement) return;
    var selector = buildSelector(el);
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    try {
      window.parent.postMessage({
        type: 'ecg-element-selected',
        selector: selector,
        tagName: el.tagName.toLowerCase(),
        text: (el.innerText || '').slice(0, 100),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        // Prefill values for a precise-edit panel   not full computed style,
        // just the handful of properties users actually tweak by hand.
        style: {
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          fontSize: cs.fontSize
        }
      }, '*');
    } catch (err) {}
  }, true);

  document.addEventListener('mousemove', function (e) {
    if (!_inspectActive) return;
    var el = e.target;
    if (el && el !== document.body && el !== document.documentElement) highlight(el);
  });
})();
