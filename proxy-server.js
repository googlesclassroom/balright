/**
 * Balright Custom Proxy Server
 * Pure Node.js — zero third-party dependencies.
 * Run: node proxy-server.js
 * Proxy a URL: http://localhost:8080/b/<base64url-encoded-target>
 */

'use strict';

const http  = require('http');
const https = require('https');
const url   = require('url');
const PORT  = process.env.PORT || 8080;

// ── Encoding helpers ──────────────────────────────────────────────────────────

function encB64(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decB64(enc) {
  const pad = enc.length % 4 === 0 ? 0 : 4 - (enc.length % 4);
  const padded = enc.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(padded, 'base64').toString('utf8');
}

// ── CORS headers ──────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':   '*',
  'Access-Control-Allow-Methods':  'GET, POST, OPTIONS, HEAD, PUT, PATCH, DELETE',
  'Access-Control-Allow-Headers':  '*',
  'Access-Control-Expose-Headers': '*',
};

// ── Security headers to strip from upstream ───────────────────────────────────

const STRIP_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-type-options',
  'strict-transport-security',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
]);

// ── HTML rewriter ─────────────────────────────────────────────────────────────

function rewriteHtml(html, targetUrl, proxyOrigin) {
  const base = new URL(targetUrl);

  function resolveToProxy(val) {
    if (!val) return val;
    const v = val.trim();
    if (!v || /^(data:|blob:|javascript:|#|mailto:|tel:)/i.test(v)) return v;
    try {
      const abs = new URL(v, base.href).href;
      return `${proxyOrigin}/b/${encB64(abs)}`;
    } catch {
      return val;
    }
  }

  // Rewrite src/href/action/poster/formaction/data-src attributes
  html = html.replace(
    /(\s(?:src|href|action|poster|formaction|data-src))\s*=\s*(['"])(.*?)\2/gi,
    (match, attr, quote, val) => {
      if (val.startsWith('#')) return match;
      return `${attr}=${quote}${resolveToProxy(val)}${quote}`;
    }
  );

  // Rewrite srcset attributes
  html = html.replace(
    /(\ssrcset)\s*=\s*(['"])(.*?)\2/gi,
    (match, attr, quote, val) => {
      const rewritten = val.split(',').map((part) => {
        const trimmed = part.trim();
        const spaceIdx = trimmed.search(/\s/);
        if (spaceIdx === -1) return resolveToProxy(trimmed);
        const u = trimmed.slice(0, spaceIdx);
        const descriptor = trimmed.slice(spaceIdx);
        return resolveToProxy(u) + descriptor;
      }).join(', ');
      return `${attr}=${quote}${rewritten}${quote}`;
    }
  );

  // Rewrite url() in inline styles
  html = html.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, q, val) => {
    if (!val || val.startsWith('data:')) return match;
    return `url(${q}${resolveToProxy(val)}${q})`;
  });

  // Strip CSP meta tags
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*['"]content-security-policy['"][^>]*>/gi, '');

  // Runtime JS patch: intercepts fetch + XHR so in-page requests route through proxy
  const runtimePatch = `<script>
(function(){
  var W="${proxyOrigin}", B="${base.origin}";
  function enc(s){
    try {
      return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
    } catch (e) {
      return s;
    }
  }
  function rw(u){
    if(!u||typeof u!=='string')return u;
    var s=u.trim();
    if(!s||/^(data:|blob:|javascript:|#|mailto:|tel:)/i.test(s))return s;
    if(s.startsWith(W))return s;
    try { return W + '/b/' + enc(new URL(s, B).href); } catch (e) { return u; }
  }
  function wrapRequest(input){
    if (typeof input === 'string') return rw(input);
    if (input && typeof input === 'object' && typeof input.url === 'string') {
      var clone = new Request(rw(input.url), input);
      return clone;
    }
    return input;
  }
  if (window.fetch) {
    var oF = window.fetch.bind(window);
    window.fetch = function(input, init) {
      return oF(wrapRequest(input), init);
    };
  }
  if (window.XMLHttpRequest) {
    var oO = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, async, user, password){
      if (typeof url === 'string') url = rw(url);
      return oO.call(this, method, url, async, user, password);
    };
  }
  if (window.WebSocket) {
    var OldWS = window.WebSocket;
    window.WebSocket = function(url, protocols){
      return new OldWS(rw(url), protocols);
    };
  }
  if (window.EventSource) {
    var OldES = window.EventSource;
    window.EventSource = function(url, init){
      return new OldES(rw(url), init);
    };
  }
  if (window.navigator && window.navigator.sendBeacon) {
    var oldSB = window.navigator.sendBeacon.bind(window.navigator);
    window.navigator.sendBeacon = function(url, data){
      return oldSB(rw(url), data);
    };
  }
  try {
    var oldAssign = window.location.assign;
    window.location.assign = function(u){ return oldAssign.call(this, rw(u)); };
  } catch (e) {}
  try {
    var oldReplace = window.location.replace;
    window.location.replace = function(u){ return oldReplace.call(this, rw(u)); };
  } catch (e) {}
})();
<\/script>`;

  html = html.replace(
    /<head([^>]*)>/i,
    `<head$1><base href="${base.href}">${runtimePatch}`
  );

  return html;
}

// ── CSS rewriter ──────────────────────────────────────────────────────────────

function rewriteCss(css, targetUrl, proxyOrigin) {
  const base = new URL(targetUrl);
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, q, val) => {
    if (!val || val.startsWith('data:')) return match;
    try {
      const abs = new URL(val.trim(), base.href).href;
      return `url(${q}${proxyOrigin}/b/${encB64(abs)}${q})`;
    } catch {
      return match;
    }
  });
}

// ── Upstream fetch using built-in http/https ──────────────────────────────────

function fetchUpstream(targetUrl, method, requestHeaders, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const targetOrigin = parsed.origin;

    const headers = {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept':          requestHeaders['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer':         `${targetOrigin}/`,
      'Origin':          targetOrigin,
    };

    const options = {
      method:  method || 'GET',
      headers,
    };

    const req = lib.request(parsed.href, options, (res) => {
      // Follow redirects (max 5)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirected = new URL(res.headers.location, parsed.href).href;
        return fetchUpstream(redirected, 'GET', requestHeaders, null)
          .then(resolve).catch(reject);
      }
      resolve(res);
    });

    req.on('error', reject);

    if (body && !['GET', 'HEAD'].includes(method)) {
      body.pipe(req);
    } else {
      req.end();
    }
  });
}

// ── Collect response body as Buffer ──────────────────────────────────────────

function collectBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end',  () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ── Proxy page HTML ───────────────────────────────────────────────────────────

function proxyPageHtml(proxyOrigin) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Proxy</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;background:#05070c;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1rem;font-family:'Bahnschrift','Segoe UI',Tahoma,Geneva,Verdana,sans-serif;}
  .row{display:flex;gap:.55rem;width:min(36rem,100%);}
  input{flex:1;padding:.82rem .9rem;border-radius:.65rem;border:1px solid rgba(39,48,68,.98);background:rgba(3,5,10,.92);color:#f5f7fb;font-size:.9rem;outline:none;min-width:0;transition:border-color .2s;}
  input:focus{border-color:rgba(69,113,255,.95);box-shadow:0 0 0 1px rgba(69,113,255,.18);}
  input::placeholder{color:#566174;}
  button{padding:.82rem 1.4rem;border-radius:.65rem;background:linear-gradient(180deg,#4f83ff 0%,#3c68ea 100%);border:1px solid rgba(100,141,255,.95);color:#fff;font-size:.9rem;font-weight:700;cursor:pointer;white-space:nowrap;}
  button:hover{filter:brightness(1.1);}
  .shortcuts{display:flex;flex-wrap:wrap;gap:.4rem;width:min(36rem,100%);margin-top:.6rem;}
  .sc-item{display:flex;align-items:center;}
  .shortcuts button{padding:.45rem .9rem;font-size:.8rem;font-weight:600;border-radius:.5rem;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#a0b0c8;cursor:pointer;width:auto;}
  .shortcuts button:hover{background:rgba(255,255,255,.12);color:#fff;filter:none;}
  .sc-remove{padding:.3rem .45rem !important;font-size:.7rem !important;background:transparent !important;border:none !important;color:#566174 !important;margin-left:1px;}
  .sc-remove:hover{color:#e35f5f !important;}
  .add-row{display:flex;gap:.4rem;width:min(36rem,100%);margin-top:.75rem;}
  .add-row input{flex:1;padding:.55rem .75rem;border-radius:.55rem;border:1px solid rgba(39,48,68,.98);background:rgba(3,5,10,.92);color:#f5f7fb;font-size:.82rem;outline:none;min-width:0;}
  .add-row input:focus{border-color:rgba(69,113,255,.6);}
  .add-row input::placeholder{color:#566174;}
  .add-row button{padding:.55rem .9rem;font-size:.82rem;font-weight:700;border-radius:.55rem;background:rgba(79,131,255,.18);border:1px solid rgba(79,131,255,.4);color:#7fa8ff;cursor:pointer;white-space:nowrap;}
  .add-row button:hover{background:rgba(79,131,255,.28);}
</style>
</head>
<body>
<div class="row">
  <input id="url-input" type="url" placeholder="https://example.com" autocomplete="off" spellcheck="false">
  <button onclick="go()">Go</button>
</div>
<div class="shortcuts" id="shortcuts"></div>
<div class="add-row">
  <input id="sc-name" placeholder="Name" maxlength="20" autocomplete="off" />
  <input id="sc-url" type="url" placeholder="https://example.com" autocomplete="off" />
  <button onclick="addShortcut()">+ Add</button>
</div>
<div id="bookmark-hint" style="display:none;color:#566174;font-size:.74rem;margin-top:.5rem;width:min(36rem,100%);text-align:center;">Bookmark this page now to save your shortcuts!</div>
<script>
  const ORIGIN = "${proxyOrigin}";
  function enc(s){
    return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
  }
  function go(){
    let target = document.getElementById('url-input').value.trim();
    if(!target) return;
    if(!/^https?:\\/\\//i.test(target)) target = 'https://' + target;
    try{ new URL(target); } catch(e){ return; }
    window.location.href = ORIGIN + '/b/' + enc(target);
  }
  function nav(url){ window.location.href = ORIGIN + '/b/' + enc(url); }
  document.getElementById('url-input').addEventListener('keydown', e => { if(e.key==='Enter') go(); });

  const DEFAULTS = [
    {name:'YouTube', url:'https://youtube.com'},
    {name:'Google',  url:'https://google.com'},
    {name:'ChatGPT', url:'https://chatgpt.com'},
    {name:'Spotify', url:'https://spotify.com'},
    {name:'Twitch',  url:'https://twitch.tv'},
  ];

  function loadShortcuts() {
    try {
      const raw = decodeURIComponent(location.hash.slice(1));
      if (raw) return JSON.parse(raw);
    } catch {}
    return DEFAULTS;
  }

  function saveShortcuts(list) {
    location.hash = encodeURIComponent(JSON.stringify(list));
    document.getElementById('bookmark-hint').style.display = 'block';
  }

  function renderShortcuts() {
    const list = loadShortcuts();
    const el = document.getElementById('shortcuts');
    el.innerHTML = list.map((s, i) => {
      const safe = s.name.replace(/"/g,'&quot;');
      const url = s.url.replace(/"/g,'&quot;');
      return \`<span class="sc-item"><button onclick="nav('\${url}')">\${safe}</button><button class="sc-remove" title="Remove" onclick="removeShortcut(\${i})">✕</button></span>\`;
    }).join('');
  }

  function addShortcut() {
    const name = document.getElementById('sc-name').value.trim().slice(0,20);
    let url = document.getElementById('sc-url').value.trim();
    if(!name || !url) return;
    if(!/^https?:\\/\\//.test(url)) url = 'https://' + url;
    try { new URL(url); } catch { return; }
    const list = loadShortcuts();
    list.push({name, url});
    saveShortcuts(list);
    document.getElementById('sc-name').value = '';
    document.getElementById('sc-url').value = '';
    renderShortcuts();
  }

  function removeShortcut(i) {
    const list = loadShortcuts();
    list.splice(i, 1);
    saveShortcuts(list);
    renderShortcuts();
  }

  renderShortcuts();
</script>
</body>
</html>`;
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const reqUrl    = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const proxyOrigin = `http://${req.headers.host || `localhost:${PORT}`}`;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  // Serve proxy homepage
  if (reqUrl.pathname === '/' || reqUrl.pathname === '') {
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(proxyPageHtml(proxyOrigin));
  }

  // Only handle /b/<encoded> paths
  const pathMatch = reqUrl.pathname.match(/^\/b\/(.+)$/);
  if (!pathMatch) {
    res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  let targetUrl;
  try {
    targetUrl = decB64(pathMatch[1]);
  } catch {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    return res.end('Bad encoding');
  }

  if (!/^https?:\/\//i.test(targetUrl)) {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    return res.end('Only http/https targets allowed');
  }

  // Append query string from proxy request to upstream URL
  const fullTarget = reqUrl.search ? targetUrl + reqUrl.search : targetUrl;

  let upstream;
  try {
    upstream = await fetchUpstream(fullTarget, req.method, req.headers, req);
  } catch (err) {
    res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    return res.end(`Proxy fetch error: ${err.message}`);
  }

  const contentType = upstream.headers['content-type'] || '';

  // Build response headers — strip security headers, add CORS
  const respHeaders = { ...CORS_HEADERS };
  for (const [k, v] of Object.entries(upstream.headers)) {
    if (!STRIP_HEADERS.has(k.toLowerCase())) {
      respHeaders[k] = v;
    }
  }

  if (contentType.includes('text/html')) {
    const body = await collectBody(upstream);
    const rawHtml = body.toString('utf8');
    const rewritten = rewriteHtml(rawHtml, targetUrl, proxyOrigin);
    respHeaders['content-type'] = 'text/html; charset=utf-8';
    delete respHeaders['content-encoding']; // body already decoded by Node
    delete respHeaders['transfer-encoding'];
    respHeaders['content-length'] = Buffer.byteLength(rewritten, 'utf8').toString();
    res.writeHead(upstream.statusCode, respHeaders);
    return res.end(rewritten);
  }

  if (contentType.includes('text/css')) {
    const body = await collectBody(upstream);
    const rawCss = body.toString('utf8');
    const rewritten = rewriteCss(rawCss, targetUrl, proxyOrigin);
    respHeaders['content-type'] = contentType;
    delete respHeaders['content-encoding'];
    delete respHeaders['transfer-encoding'];
    respHeaders['content-length'] = Buffer.byteLength(rewritten, 'utf8').toString();
    res.writeHead(upstream.statusCode, respHeaders);
    return res.end(rewritten);
  }

  // All other content: stream directly
  delete respHeaders['content-encoding']; // let Node handle it transparently
  res.writeHead(upstream.statusCode, respHeaders);
  upstream.pipe(res);
}

// ── Start server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
    }
    res.end('Internal server error');
  });
});

server.listen(PORT, () => {
  console.log(`Balright proxy running at http://localhost:${PORT}`);
  console.log(`Proxy a site: http://localhost:${PORT}/b/<base64url-encoded-target>`);
});
