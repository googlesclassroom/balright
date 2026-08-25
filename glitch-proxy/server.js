const express = require('express');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,HEAD,PUT,PATCH,DELETE');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function encB64(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decB64(enc) {
  return Buffer.from(enc.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function rewriteHtml(html, targetUrl, workerOrigin) {
  const base = new URL(targetUrl);

  function resolveToProxy(val) {
    if (!val) return val;
    const v = val.trim();
    if (!v || /^(data:|blob:|javascript:|#|mailto:|tel:)/i.test(v)) return v;
    try {
      const abs = new URL(v, base.href).href;
      return `${workerOrigin}/b/${encB64(abs)}`;
    } catch { return val; }
  }

  html = html.replace(/(\s(?:src|href|action|poster|formaction|data-src))\s*=\s*(['"])(.*?)\2/gi,
    (match, attr, quote, val) => val.startsWith('#') ? match : `${attr}=${quote}${resolveToProxy(val)}${quote}`
  );

  html = html.replace(/(\ssrcset)\s*=\s*(['"])(.*?)\2/gi, (match, attr, quote, val) => {
    const rewritten = val.split(',').map(part => {
      const trimmed = part.trim();
      const si = trimmed.search(/\s/);
      if (si === -1) return resolveToProxy(trimmed);
      return resolveToProxy(trimmed.slice(0, si)) + trimmed.slice(si);
    }).join(', ');
    return `${attr}=${quote}${rewritten}${quote}`;
  });

  html = html.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, val) =>
    !val || val.startsWith('data:') ? m : `url(${q}${resolveToProxy(val)}${q})`
  );

  html = html.replace(/<meta[^>]+http-equiv\s*=\s*['"]content-security-policy['"][^>]*>/gi, '');

  const patch = `<script>(function(){var W="${workerOrigin}",B="${base.origin}";function enc(s){try{return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'')}catch(e){return s;}}function rw(u){if(!u||typeof u!=='string')return u;var s=u.trim();if(!s||/^(data:|blob:|javascript:|#)/.test(s))return s;if(s.startsWith(W))return s;try{return W+'/b/'+enc(new URL(s,B).href);}catch(e){return u;}}var oF=window.fetch;window.fetch=function(r,o){return oF.call(this,typeof r==='string'?rw(r):r,o);};var oO=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=Array.prototype.slice.call(arguments);a[1]=rw(u);return oO.apply(this,a);};})();<\/script>`;

  html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${base.href}">${patch}`);
  return html;
}

app.get('/b/:encoded(*)', async (req, res) => {
  let targetUrl;
  try { targetUrl = decB64(req.params.encoded); } catch {
    return res.status(400).send('Bad encoding');
  }
  if (!/^https?:\/\//i.test(targetUrl)) return res.status(400).send('Invalid URL');

  const fullTarget = targetUrl + (req.query && Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '');
  const parsed = new URL(fullTarget);
  const lib = parsed.protocol === 'https:' ? https : http;
  const workerOrigin = `${req.protocol}://${req.get('host')}`;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': parsed.origin + '/',
      'Origin': parsed.origin,
    },
  };

  const upstream = lib.request(options, (upRes) => {
    const ct = upRes.headers['content-type'] || '';
    const dropHeaders = ['x-frame-options','content-security-policy','x-content-type-options',
      'strict-transport-security','cross-origin-opener-policy','cross-origin-embedder-policy','cross-origin-resource-policy'];
    const outHeaders = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (!dropHeaders.includes(k.toLowerCase())) outHeaders[k] = v;
    }
    outHeaders['access-control-allow-origin'] = '*';

    if (ct.includes('text/html')) {
      let body = '';
      upRes.setEncoding('utf8');
      upRes.on('data', c => body += c);
      upRes.on('end', () => {
        const rewritten = rewriteHtml(body, targetUrl, workerOrigin);
        outHeaders['content-type'] = 'text/html; charset=utf-8';
        delete outHeaders['content-length'];
        res.writeHead(upRes.statusCode, outHeaders);
        res.end(rewritten);
      });
    } else {
      res.writeHead(upRes.statusCode, outHeaders);
      upRes.pipe(res);
    }
  });

  upstream.on('error', err => res.status(502).send(`Bridge error: ${err.message}`));
  if (!['GET','HEAD'].includes(req.method)) req.pipe(upstream);
  else upstream.end();
});

app.get('/', (req, res) => res.send('Bridge is online.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT);
