/* facet dashboard — builds the pane grid and points every pane at the mirror proxy */

const PRESETS = [
  { key: 'mobile',   label: 'Mobile',        w: 390,  h: 844,  modes: [],                 on: true },
  { key: 'tablet',   label: 'Tablet',        w: 820,  h: 1180, modes: [],                 on: true },
  { key: 'laptop',   label: 'Laptop',        w: 1366, h: 768,  modes: [],                 on: true },
  { key: 'desktop',  label: 'Desktop',       w: 1920, h: 1080, modes: [],                 on: true },
  { key: 'dark',     label: 'Dark mode',     w: 1366, h: 768,  modes: ['dark'],           on: true },
  { key: 'm-dark',   label: 'Mobile · Dark', w: 390,  h: 844,  modes: ['dark'],           on: false },
  { key: 'rtl',      label: 'RTL',           w: 1366, h: 768,  modes: ['rtl'],            on: false },
  { key: 'motion',   label: 'Reduced motion',w: 1366, h: 768,  modes: ['reduced-motion'], on: false },
  { key: 'gray',     label: 'Grayscale',     w: 1366, h: 768,  modes: ['grayscale'],      on: false },
];

// display width budget per pane (panes are scaled down to roughly this)
const PANE_DISPLAY_W = { small: 300, large: 460 };

const grid = document.getElementById('grid');
const form = document.getElementById('target-form');
const urlInput = document.getElementById('target-url');
const toggles = document.getElementById('preset-toggles');

let proxyPort = 4401;
let targetSet = false;

for (const p of PRESETS) {
  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = p.on;
  cb.addEventListener('change', () => {
    p.on = cb.checked;
    if (targetSet) render();
  });
  label.append(cb, p.label);
  toggles.append(label);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/target', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: urlInput.value.trim() }),
  });
  const data = await res.json();
  if (!data.ok) {
    alert(`Could not set target: ${data.error}`);
    return;
  }
  proxyPort = data.proxyPort;
  targetSet = true;
  render();
});

function render() {
  grid.innerHTML = '';
  const mirror = `${location.protocol}//${location.hostname}:${proxyPort}/`;

  for (const p of PRESETS.filter((p) => p.on)) {
    const budget = p.w <= 500 ? PANE_DISPLAY_W.small : PANE_DISPLAY_W.large;
    const scale = Math.min(1, budget / p.w);

    const pane = document.createElement('div');
    pane.className = 'pane';

    const head = document.createElement('div');
    head.className = 'pane-head';
    head.innerHTML = `<span class="label">${p.label}</span><span>${p.w}×${p.h} · ${Math.round(scale * 100)}%</span>`;

    const view = document.createElement('div');
    view.className = 'pane-view';
    view.style.width = `${p.w * scale}px`;
    view.style.height = `${p.h * scale}px`;

    const frame = document.createElement('iframe');
    frame.width = p.w;
    frame.height = p.h;
    frame.style.transform = `scale(${scale})`;
    // pane config rides in window.name so it survives in-pane navigation
    frame.name = JSON.stringify({ facet: true, id: p.key, modes: p.modes });
    frame.src = mirror;

    view.append(frame);
    pane.append(head, view);
    grid.append(pane);
  }
}

// restore state if the server already has a target (e.g. passed on the CLI)
fetch('/api/target')
  .then((r) => r.json())
  .then((data) => {
    proxyPort = data.proxyPort || proxyPort;
    if (data.target) {
      urlInput.value = data.target;
      targetSet = true;
      render();
    }
  });
