# ◈ facet

**One site, every aspect at once.** Point facet at any frontend (a local dev server or a live URL) and it renders the site simultaneously across viewports and modes — mobile, tablet, laptop, desktop, dark mode, RTL, reduced motion, grayscale — with every interaction mirrored live between all panes. Click a button in the mobile pane and the same button is clicked in every other pane; type into a form, scroll, or navigate and every aspect follows.

## How it works

```
┌─ dashboard :4400 ─────────────────────────────┐
│  ┌─ mobile ─┐ ┌─ tablet ─┐ ┌─ desktop·dark ─┐ │
│  │ iframe   │ │ iframe   │ │ iframe         │ │
│  └────┬─────┘ └────┬─────┘ └───────┬────────┘ │
└───────┼────────────┼───────────────┼──────────┘
        └────────────┼───────────────┘
             mirror proxy :4401
        (rewrites HTML, strips X-Frame-Options/CSP,
         injects sync-client.js, hosts the WS bus)
                     │
               target site
```

- **Mirror proxy** (`:4401`) serves the target site at its own root so all relative and root-relative URLs keep working, strips frame-blocking headers, and injects a small sync client at the top of `<head>`.
- **Sync client** captures trusted clicks, input, select changes, form submits, scrolls (as a percentage) and SPA navigations, then broadcasts them over a WebSocket bus. Other panes replay them — inputs use the native value setter + synthetic `input` event so React-controlled forms update correctly.
- **Aspect modes** ride in each iframe's `window.name` (so they survive navigation). Dark/light and reduced-motion are emulated by patching `matchMedia` before site JS runs; RTL flips `dir`; grayscale applies a root filter.

## Run

```bash
npm install
npm start                        # dashboard on :4400, mirror on :4401
# or pass the target directly:
node server.js https://example.com
```

Open http://localhost:4400, enter a URL, hit **Render**. Toggle aspect presets in the header chips.

## Notes & limits

- Element matching across panes uses id/nth-of-type selectors — works well when panes render the same DOM; responsive layouts that render *different* components (e.g. a mobile hamburger menu) won't have a counterpart to click.
- Dark-mode emulation covers `matchMedia`/`color-scheme` based theming; sites toggled purely by a server-side or storage-persisted class may need their own toggle clicked once (which then mirrors everywhere).
- Sites behind auth work if login is performed in a pane (cookies are rewritten for localhost), but hardened SSO flows may refuse the proxy.
- HTTPS targets are fine; the mirror itself is plain HTTP on localhost.

## Ideas / roadmap

- Per-pane locale & timezone emulation
- Hover mirroring with ghost cursors showing where other panes are pointing
- Element-level scroll sync (inner scroll containers)
- Screenshot strip: capture all panes at once for visual review
