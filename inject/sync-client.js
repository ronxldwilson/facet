/**
 * facet sync client — injected into every mirrored pane.
 *
 * Captures clicks, typing, scrolling, form submits and SPA navigations in
 * this pane and broadcasts them over the WebSocket bus; replays events
 * arriving from other panes. Pane config (id + aspect modes) rides in
 * window.name so it survives navigation.
 */
(() => {
  if (window.__facet) return;
  window.__facet = true;

  /* ---------------- pane config (set by the dashboard via iframe name) */
  let cfg = { id: 'pane-' + Math.random().toString(36).slice(2, 8), modes: [] };
  try {
    const parsed = JSON.parse(window.name);
    if (parsed && parsed.facet) cfg = parsed;
  } catch (_) { /* standalone tab — defaults are fine */ }

  /* ---------------- aspect modes, applied before site JS runs */
  if (cfg.modes.includes('dark') || cfg.modes.includes('light')) {
    const scheme = cfg.modes.includes('dark') ? 'dark' : 'light';
    document.documentElement.style.colorScheme = scheme;
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const mql = nativeMatchMedia(query);
      if (/prefers-color-scheme/.test(query)) {
        const matches = query.includes(scheme);
        return new Proxy(mql, {
          get: (t, p) => (p === 'matches' ? matches : typeof t[p] === 'function' ? t[p].bind(t) : t[p]),
        });
      }
      return mql;
    };
  }
  if (cfg.modes.includes('rtl')) {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.dir = 'rtl';
    });
  }
  if (cfg.modes.includes('reduced-motion')) {
    const nativeMatchMedia2 = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const mql = nativeMatchMedia2(query);
      if (/prefers-reduced-motion/.test(query)) {
        return new Proxy(mql, {
          get: (t, p) => (p === 'matches' ? query.includes('reduce') : typeof t[p] === 'function' ? t[p].bind(t) : t[p]),
        });
      }
      return mql;
    };
  }
  if (cfg.modes.includes('grayscale')) {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.filter = 'grayscale(1)';
    });
  }

  /* ---------------- websocket bus */
  let ws = null;
  let applying = false;      // true while replaying a remote event
  let applyingScrollUntil = 0;

  function connect() {
    ws = new WebSocket(`ws://${location.host}/__facet/ws`);
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.from === cfg.id) return;
      replay(msg);
    };
    ws.onclose = () => setTimeout(connect, 1000);
  }
  connect();

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ ...msg, from: cfg.id }));
  }

  /* ---------------- stable-ish selector for an element */
  function selectorFor(el) {
    if (!(el instanceof Element)) return null;
    const parts = [];
    let node = el;
    while (node && node !== document.documentElement) {
      if (node.id && !/\d{3,}/.test(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      let idx = 1;
      let sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === node.tagName) idx++;
      }
      parts.unshift(`${tag}:nth-of-type(${idx})`);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function find(sel) {
    try { return document.querySelector(sel); } catch (_) { return null; }
  }

  /* ---------------- capture local interactions */
  document.addEventListener('click', (e) => {
    if (applying || !e.isTrusted) return;
    const sel = selectorFor(e.target);
    if (sel) send({ type: 'click', sel });
  }, true);

  document.addEventListener('input', (e) => {
    if (applying || !e.isTrusted) return;
    const el = e.target;
    if (!('value' in el)) return;
    const sel = selectorFor(el);
    if (sel) send({ type: 'input', sel, value: el.value, checked: el.checked === true });
  }, true);

  document.addEventListener('change', (e) => {
    if (applying || !e.isTrusted) return;
    const el = e.target;
    if (el.tagName !== 'SELECT') return;
    const sel = selectorFor(el);
    if (sel) send({ type: 'select', sel, value: el.value });
  }, true);

  document.addEventListener('submit', (e) => {
    if (applying || !e.isTrusted) return;
    const sel = selectorFor(e.target);
    if (sel) send({ type: 'submit', sel });
  }, true);

  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    if (Date.now() < applyingScrollUntil) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const doc = document.documentElement;
      const maxY = Math.max(1, doc.scrollHeight - window.innerHeight);
      const maxX = Math.max(1, doc.scrollWidth - window.innerWidth);
      send({ type: 'scroll', y: window.scrollY / maxY, x: window.scrollX / maxX });
    }, 60);
  }, { passive: true });

  // SPA navigations (pushState-based routers)
  const push = history.pushState.bind(history);
  history.pushState = function (...args) {
    push(...args);
    if (!applying) send({ type: 'nav', path: location.pathname + location.search + location.hash });
  };
  window.addEventListener('popstate', () => {
    if (!applying) send({ type: 'nav', path: location.pathname + location.search + location.hash });
  });

  /* ---------------- replay remote interactions */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function replay(msg) {
    applying = true;
    try {
      switch (msg.type) {
        case 'click': {
          const el = find(msg.sel);
          if (el) el.click();
          break;
        }
        case 'input': {
          const el = find(msg.sel);
          if (!el) break;
          if (el.type === 'checkbox' || el.type === 'radio') {
            if (el.checked !== msg.checked) el.click();
          } else {
            setNativeValue(el, msg.value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          break;
        }
        case 'select': {
          const el = find(msg.sel);
          if (!el) break;
          setNativeValue(el, msg.value);
          el.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
        case 'submit': {
          const el = find(msg.sel);
          if (el && el.requestSubmit) el.requestSubmit();
          break;
        }
        case 'scroll': {
          applyingScrollUntil = Date.now() + 250;
          const doc = document.documentElement;
          const maxY = Math.max(0, doc.scrollHeight - window.innerHeight);
          const maxX = Math.max(0, doc.scrollWidth - window.innerWidth);
          window.scrollTo(maxX * msg.x, maxY * msg.y);
          break;
        }
        case 'nav': {
          const current = location.pathname + location.search + location.hash;
          if (current !== msg.path) location.href = msg.path;
          break;
        }
      }
    } finally {
      applying = false;
    }
  }
})();
