#!/usr/bin/env node
/**
 * facet — one site, every aspect at once.
 *
 * Two servers:
 *   :4400  dashboard UI (pane grid, target picker)
 *   :4401  mirror proxy — serves the target site at its own root, strips
 *          frame-blocking headers, injects the sync client, and hosts the
 *          WebSocket bus that fans interactions out to every pane.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const DASH_PORT = Number(process.env.FACET_DASH_PORT || 4400);
const PROXY_PORT = Number(process.env.FACET_PROXY_PORT || 4401);

let target = process.argv[2] || null; // e.g. https://example.com

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Dashboard server                                                    */
/* ------------------------------------------------------------------ */

const dash = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/target') {
    if (req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const parsed = new URL(body.url); // validates
        if (!/^https?:$/.test(parsed.protocol)) throw new Error('http(s) only');
        target = parsed.href;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, target, proxyPort: PROXY_PORT }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ target, proxyPort: PROXY_PORT }));
    return;
  }

  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const resolved = path.join(__dirname, 'public', path.normalize(file));
  if (!resolved.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403).end();
    return;
  }
  serveFile(res, resolved);
});

/* ------------------------------------------------------------------ */
/* Mirror proxy                                                        */
/* ------------------------------------------------------------------ */

const STRIP_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'content-encoding', // fetch already decompressed the body
  'content-length',
  'transfer-encoding',
  'strict-transport-security',
]);

const STRIP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'accept-encoding', 'origin', 'referer',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'upgrade-insecure-requests',
]);

const INJECT_TAG = '<script src="/__facet/sync-client.js"></script>';

const proxy = http.createServer(async (req, res) => {
  if (req.url.startsWith('/__facet/sync-client.js')) {
    serveFile(res, path.join(__dirname, 'inject', 'sync-client.js'));
    return;
  }

  if (!target) {
    res.writeHead(503, { 'content-type': 'text/html' });
    res.end('<h2 style="font-family:sans-serif">facet: no target set — open the dashboard and enter a URL.</h2>');
    return;
  }

  const targetOrigin = new URL(target).origin;
  const upstream = new URL(req.url, targetOrigin);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers['host'] = new URL(targetOrigin).host;
  headers['accept-encoding'] = 'identity';

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);

  let response;
  try {
    response = await fetch(upstream, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
    });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`facet proxy error: ${e.message}`);
    return;
  }

  const outHeaders = {};
  for (const [k, v] of response.headers.entries()) {
    if (STRIP_RESPONSE_HEADERS.has(k)) continue;
    if (k === 'location') {
      // keep same-origin redirects inside the mirror
      outHeaders[k] = v.startsWith(targetOrigin)
        ? v.slice(targetOrigin.length) || '/'
        : v;
      continue;
    }
    outHeaders[k] = v;
  }
  // re-emit cookies without Domain/Secure so they stick to localhost
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (setCookies.length) {
    outHeaders['set-cookie'] = setCookies.map((c) =>
      c.replace(/;\s*Domain=[^;]*/gi, '').replace(/;\s*Secure/gi, '')
    );
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    let html = await response.text();
    // absolute same-origin URLs → mirror-relative so they stay proxied
    html = html.split(targetOrigin).join('');
    // inject the sync client as early as possible so it runs before site JS
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m) => m + INJECT_TAG);
    } else {
      html = INJECT_TAG + html;
    }
    outHeaders['content-type'] = contentType;
    res.writeHead(response.status, outHeaders);
    res.end(html);
    return;
  }

  res.writeHead(response.status, outHeaders);
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
});

/* ------------------------------------------------------------------ */
/* WebSocket bus — every message fans out to all other panes           */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server: proxy, path: '/__facet/ws' });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    for (const client of wss.clients) {
      if (client !== ws && client.readyState === 1) client.send(data.toString());
    }
  });
});

dash.listen(DASH_PORT, () => {
  console.log(`facet dashboard  →  http://localhost:${DASH_PORT}`);
});
proxy.listen(PROXY_PORT, () => {
  console.log(`facet mirror     →  http://localhost:${PROXY_PORT}${target ? `  (target: ${target})` : '  (no target yet)'}`);
});
