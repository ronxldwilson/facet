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
const crypto = require('crypto');
const { Readable } = require('stream');
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
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      // facet's own assets must never be stale-cached across facet updates
      'cache-control': 'no-store',
    });
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

function buildUpstreamHeaders(req, upstream) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers['host'] = upstream.host;
  headers['origin'] = upstream.origin;
  headers['accept-encoding'] = 'identity';
  return headers;
}

function buildDownstreamHeaders(response, upstream) {
  const outHeaders = {};
  for (const [k, v] of response.headers.entries()) {
    if (STRIP_RESPONSE_HEADERS.has(k)) continue;
    if (k === 'location') {
      // keep same-origin redirects inside the proxy
      outHeaders[k] = v.startsWith(upstream.origin)
        ? v.slice(upstream.origin.length) || '/'
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
  return outHeaders;
}

/**
 * Forward a request to `upstream` and write the response to `res`.
 * When `injectInto` is set (the origin being mirrored), HTML responses get
 * the sync client injected; everything else streams through untouched, so
 * SSE / streaming responses work.
 */
async function forward(req, res, upstream, { injectInto = null } = {}) {
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);

  let response;
  try {
    response = await fetch(upstream, {
      method: req.method,
      headers: buildUpstreamHeaders(req, upstream),
      body,
      // mirrored pages: follow redirects server-side so a cross-origin hop
      // (google.com → www.google.com) can never carry the iframe out of the
      // mirror; API passthrough keeps redirects manual for the client to see
      redirect: injectInto ? 'follow' : 'manual',
    });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`facet proxy error: ${e.message}`);
    return;
  }

  const outHeaders = buildDownstreamHeaders(response, upstream);

  const contentType = response.headers.get('content-type') || '';
  if (injectInto && contentType.includes('text/html')) {
    let html = await response.text();
    // absolute same-origin URLs → mirror-relative so they stay proxied;
    // also rewrite the post-redirect origin (e.g. www.google.com) if it moved
    html = html.split(injectInto).join('');
    if (response.url) {
      const finalOrigin = new URL(response.url).origin;
      if (finalOrigin !== injectInto) html = html.split(finalOrigin).join('');
    }
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
  if (!response.body) {
    res.end();
    return;
  }
  // stream so SSE / chunked responses (e.g. LLM chat) pass through live
  Readable.fromWeb(response.body).pipe(res);
}

/* ------------------------------------------------------------------ */
/* API dedup — panes replay the same interaction near-simultaneously,  */
/* so identical requests within a short window hit the backend ONCE;   */
/* every pane gets a copy of the single response, streamed live.       */
/* ------------------------------------------------------------------ */

const DEDUP_WINDOW_MS = Number(process.env.FACET_DEDUP_MS || 1500);
const MAX_REPLAY_BYTES = 10 * 1024 * 1024; // stop buffering huge bodies for late joiners

const inflight = new Map(); // dedup key -> entry

function dedupKey(req, upstream, body) {
  return crypto.createHash('sha1')
    .update(req.method).update('\0')
    .update(upstream.href).update('\0')
    .update(req.headers.authorization || '').update('\0')
    .update(req.headers.cookie || '').update('\0')
    .update(body || '')
    .digest('hex');
}

function attachFollower(entry, res) {
  res.on('close', () => entry.followers.delete(res));
  if (entry.status !== null) {
    res.writeHead(entry.status, entry.headers);
    for (const c of entry.chunks) res.write(c);
    if (entry.done) {
      res.end();
      return;
    }
  } else {
    entry.pending.push(res);
  }
  entry.followers.add(res);
}

function endEntry(entry, key) {
  entry.done = true;
  entry.endedAt = Date.now();
  for (const r of entry.followers) r.end();
  entry.followers.clear();
  setTimeout(() => {
    if (inflight.get(key) === entry) inflight.delete(key);
  }, DEDUP_WINDOW_MS + 100).unref();
}

function flushHeaders(entry, status, headers) {
  entry.status = status;
  entry.headers = headers;
  for (const r of entry.pending) r.writeHead(status, headers);
  entry.pending = [];
}

async function forwardDeduped(req, res, upstream) {
  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);

  const key = dedupKey(req, upstream, body);
  const existing = inflight.get(key);
  if (existing && !existing.tooBig &&
      (!existing.done || Date.now() - existing.endedAt < DEDUP_WINDOW_MS)) {
    attachFollower(existing, res);
    return;
  }

  const entry = {
    status: null, headers: null, chunks: [], size: 0,
    tooBig: false, done: false, endedAt: 0,
    followers: new Set(), pending: [],
  };
  inflight.set(key, entry);
  attachFollower(entry, res);

  let response;
  try {
    response = await fetch(upstream, {
      method: req.method,
      headers: buildUpstreamHeaders(req, upstream),
      body,
      redirect: 'manual',
    });
  } catch (e) {
    const msg = Buffer.from(`facet proxy error: ${e.message}`);
    flushHeaders(entry, 502, { 'content-type': 'text/plain' });
    entry.chunks.push(msg);
    for (const r of entry.followers) r.write(msg);
    endEntry(entry, key);
    return;
  }

  flushHeaders(entry, response.status, buildDownstreamHeaders(response, upstream));

  if (!response.body) {
    endEntry(entry, key);
    return;
  }

  const stream = Readable.fromWeb(response.body);
  stream.on('data', (chunk) => {
    if (!entry.tooBig) {
      entry.size += chunk.length;
      if (entry.size > MAX_REPLAY_BYTES) {
        entry.tooBig = true; // stop replay for late joiners, keep live followers
        entry.chunks = [];
      } else {
        entry.chunks.push(chunk);
      }
    }
    for (const r of entry.followers) r.write(chunk);
  });
  stream.on('end', () => endEntry(entry, key));
  stream.on('error', () => endEntry(entry, key));
}

const proxy = http.createServer(async (req, res) => {
  if (req.url.startsWith('/__facet/sync-client.js')) {
    serveFile(res, path.join(__dirname, 'inject', 'sync-client.js'));
    return;
  }

  // Cross-origin passthrough: /__facet/net/<encoded-origin>/<path>
  // The sync client reroutes the page's fetch/XHR calls here, so API
  // requests stay same-origin in the browser and CORS never applies.
  if (req.url.startsWith('/__facet/net/')) {
    const rest = req.url.slice('/__facet/net/'.length);
    const slash = rest.indexOf('/');
    let origin;
    try {
      origin = new URL(decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash))).origin;
    } catch (_) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('facet: bad /__facet/net/ origin');
      return;
    }
    const upstream = new URL(slash === -1 ? '/' : rest.slice(slash), origin);
    await forwardDeduped(req, res, upstream);
    return;
  }

  if (!target) {
    res.writeHead(503, { 'content-type': 'text/html' });
    res.end('<h2 style="font-family:sans-serif">facet: no target set — open the dashboard and enter a URL.</h2>');
    return;
  }

  const targetOrigin = new URL(target).origin;
  await forward(req, res, new URL(req.url, targetOrigin), { injectInto: targetOrigin });
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
