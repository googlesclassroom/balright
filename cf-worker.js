function encB64(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decB64(enc) {
  return atob(enc.replace(/-/g, '+').replace(/_/g, '/'));
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD, PUT, PATCH, DELETE',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
};

function rewriteHtml(html, targetUrl, workerOrigin) {
  const base = new URL(targetUrl);

  function resolveToProxy(val) {
    if (!val) return val;
    const v = val.trim();
    if (!v || /^(data:|blob:|javascript:|#|mailto:|tel:)/i.test(v)) return v;
    try {
      const abs = new URL(v, base.href).href;
      return `${workerOrigin}/b/${encB64(abs)}`;
    } catch {
      return val;
    }
  }

  html = html.replace(
    /(\s(?:src|href|action|poster|formaction|data-src))\s*=\s*(['"])(.*?)\2/gi,
    (match, attr, quote, val) => {
      if (val.startsWith('#')) return match;
      return `${attr}=${quote}${resolveToProxy(val)}${quote}`;
    }
  );

  html = html.replace(
    /(\ssrcset)\s*=\s*(['"])(.*?)\2/gi,
    (match, attr, quote, val) => {
      const rewritten = val.split(',').map((part) => {
        const trimmed = part.trim();
        const spaceIdx = trimmed.search(/\s/);
        if (spaceIdx === -1) return resolveToProxy(trimmed);
        const url = trimmed.slice(0, spaceIdx);
        const descriptor = trimmed.slice(spaceIdx);
        return resolveToProxy(url) + descriptor;
      }).join(', ');
      return `${attr}=${quote}${rewritten}${quote}`;
    }
  );

  html = html.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, q, val) => {
    if (!val || val.startsWith('data:')) return match;
    return `url(${q}${resolveToProxy(val)}${q})`;
  });

  html = html.replace(/<meta[^>]+http-equiv\s*=\s*['"]content-security-policy['"][^>]*>/gi, '');

  const runtimePatch = `<script>
(function(){
  var W="${workerOrigin}", B="${base.origin}";
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

function rewriteCss(css, targetUrl, workerOrigin) {
  const base = new URL(targetUrl);
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, q, val) => {
    if (!val || val.startsWith('data:')) return match;
    try {
      const abs = new URL(val.trim(), base.href).href;
      return `url(${q}${workerOrigin}/b/${encB64(abs)}${q})`;
    } catch {
      return match;
    }
  });
}

Deno.serve((request) => handleRequest(request));

async function handleRequest(request) {
    const reqUrl = new URL(request.url);
    const workerOrigin = reqUrl.origin;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const pathMatch = reqUrl.pathname.match(/^\/b\/(.+)$/);
    if (!pathMatch) {
      return new Response('Bridge is online.', {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' },
      });
    }

    let targetUrl;
    try {
      targetUrl = decB64(pathMatch[1]);
    } catch {
      return new Response('Bad encoding', { status: 400, headers: CORS_HEADERS });
    }

    if (!/^https?:\/\//i.test(targetUrl)) {
      return new Response('Only http/https targets allowed', { status: 400, headers: CORS_HEADERS });
    }

    const fullTarget = reqUrl.search ? targetUrl + reqUrl.search : targetUrl;

    const upstreamHeaders = new Headers();
    upstreamHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    upstreamHeaders.set('Accept', request.headers.get('Accept') || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    upstreamHeaders.set('Accept-Language', 'en-US,en;q=0.9');
    const targetOriginHeader = new URL(targetUrl).origin;
    upstreamHeaders.set('Referer', `${targetOriginHeader}/`);
    upstreamHeaders.set('Origin', targetOriginHeader);

    const isBodyMethod = !['GET', 'HEAD'].includes(request.method);

    let upstream;
    try {
      upstream = await fetch(new Request(fullTarget, {
        method: request.method,
        headers: upstreamHeaders,
        body: isBodyMethod ? request.body : undefined,
        redirect: 'follow',
      }));
    } catch (err) {
      return new Response(`Bridge fetch error: ${err.message}`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }

    const contentType = upstream.headers.get('content-type') || '';

    const respHeaders = new Headers();
    for (const [k, v] of upstream.headers.entries()) {
      const lower = k.toLowerCase();
      if (['x-frame-options', 'content-security-policy', 'x-content-type-options',
           'strict-transport-security', 'cross-origin-opener-policy',
           'cross-origin-embedder-policy', 'cross-origin-resource-policy'].includes(lower)) continue;
      respHeaders.set(k, v);
    }
    Object.entries(CORS_HEADERS).forEach(([k, v]) => respHeaders.set(k, v));

    if (contentType.includes('text/html')) {
      const rawHtml = await upstream.text();
      const rewritten = rewriteHtml(rawHtml, targetUrl, workerOrigin);
      respHeaders.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(rewritten, { status: upstream.status, headers: respHeaders });
    }

    if (contentType.includes('text/css')) {
      const rawCss = await upstream.text();
      const rewritten = rewriteCss(rawCss, targetUrl, workerOrigin);
      respHeaders.set('Content-Type', contentType);
      return new Response(rewritten, { status: upstream.status, headers: respHeaders });
    }

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
