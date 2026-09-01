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
  var W="${proxyOrigin}",B="${base.origin}";
  function enc(s){
    try{
      var b=unescape(encodeURIComponent(s));
      var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      var out='',i=0;
      while(i<b.length){
        var a=b.charCodeAt(i++),c=i<b.length?b.charCodeAt(i++):0,d=i<b.length?b.charCodeAt(i++):0;
        out+=chars[a>>2]+chars[((a&3)<<4)|(c>>4)]+chars[((c&15)<<2)|(d>>6)]+chars[d&63];
      }
      var pad=b.length%3;
      return (pad?out.slice(0,pad-3):out).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
    }catch(e){return s;}
  }
  function rw(u){
    if(!u||typeof u!=='string')return u;
    var s=u.trim();
    if(!s||/^(data:|blob:|javascript:|#)/.test(s))return s;
    if(s.startsWith(W))return s;
    try{return W+'/b/'+enc(new URL(s,B).href);}catch(e){return u;}
  }
  var oF=window.fetch;
  window.fetch=function(r,o){return oF.call(this,typeof r==='string'?rw(r):r,o);};
  var oO=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    var a=Array.prototype.slice.call(arguments);a[1]=rw(u);return oO.apply(this,a);
  };
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
<title>Balright Proxy</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;background:#05070c;color:#f5f7fb;font-family:'Bahnschrift','Segoe UI',Tahoma,Geneva,Verdana,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1rem}
  .card{width:min(36rem,100%);background:#000;border:1px solid rgba(55,97,255,.72);border-radius:1.15rem;padding:2rem 1.75rem;box-shadow:0 18px 60px rgba(0,0,0,.52)}
  .brand{font-size:2rem;font-weight:800;letter-spacing:-.04em;text-align:center;margin-bottom:.35rem}
  .brand-accent{color:#4d7dff}
  .subtitle{color:#71809b;font-size:.82rem;text-align:center;margin-bottom:1.5rem}
  input{width:100%;padding:.82rem .9rem;border-radius:.65rem;border:1px solid rgba(39,48,68,.98);background:rgba(3,5,10,.92);color:#f5f7fb;font-size:.9rem;outline:none;transition:border-color .2s}
  input:focus{border-color:rgba(69,113,255,.95);box-shadow:0 0 0 1px rgba(69,113,255,.18)}
  input::placeholder{color:#566174}
  button{width:100%;margin-top:.8rem;padding:.82rem 1rem;border-radius:.72rem;background:linear-gradient(180deg,#4f83ff 0%,#3c68ea 100%);border:1px solid rgba(100,141,255,.95);color:#fff;font-size:.92rem;font-weight:700;cursor:pointer;box-shadow:0 10px 24px rgba(49,91,223,.28)}
  button:hover{filter:brightness(1.1)}
  #err{margin-top:.75rem;padding:.65rem .85rem;border-radius:.55rem;border:1px solid rgba(141,43,43,.7);background:rgba(63,15,15,.45);color:#e35f5f;font-size:.78rem;display:none}
  .note{margin-top:1rem;color:#4a566b;font-size:.75rem;text-align:center}
</style>
</head>
<body>
<div class="card">
  <div class="brand">bal<span class="brand-accent">right</span></div>
  <div class="subtitle">Custom Proxy &mdash; self-hosted, no third parties</div>
  <input id="url-input" type="url" placeholder="https://example.com" autocomplete="off" spellcheck="false">
  <button onclick="go()">Go</button>
  <div id="err"></div>
  <div class="note">Traffic routes through this server only. No external proxy services.</div>
</div>
<script>
  const ORIGIN = "${proxyOrigin}";
  function enc(s){
    return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
  }
  function go(){
    const raw = document.getElementById('url-input').value.trim();
    const errEl = document.getElementById('err');
    errEl.style.display='none';
    let target = raw;
    if(!/^https?:\\/\\//i.test(target)) target = 'https://' + target;
    try{ new URL(target); } catch(e){
      errEl.textContent = 'Enter a valid URL (e.g. https://example.com)';
      errEl.style.display='block'; return;
    }
    window.location.href = ORIGIN + '/b/' + enc(target);
  }
  document.getElementById('url-input').addEventListener('keydown', e => { if(e.key==='Enter') go(); });
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
