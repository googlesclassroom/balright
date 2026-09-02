/**
 * Balright Google Apps Script Proxy
 * Runs at script.google.com — schools can't block it without breaking Google Classroom.
 *
 * Deploy: Extensions > Apps Script > paste this > Deploy > New deployment
 *   Type: Web app | Execute as: Me | Who has access: Anyone
 * Proxy URL format: https://script.google.com/macros/s/YOUR_ID/exec?u=<base64url>
 */

function doGet(e) {
  const proxyBase = ScriptApp.getService().getUrl();
  const encoded = (e && e.parameter && e.parameter.u)
    || (e && e.pathInfo && e.pathInfo.replace(/^b\//, ''))
    || '';

  if (!encoded) {
    return HtmlService.createHtmlOutput(buildHomePage(proxyBase))
      .setTitle('Proxy')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  let targetUrl;
  try { targetUrl = decB64(encoded); }
  catch (_) { return text('Bad encoding'); }

  if (!/^https?:\/\//i.test(targetUrl)) return text('Invalid URL');

  let resp;
  try {
    resp = UrlFetchApp.fetch(targetUrl, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': targetUrl.match(/^https?:\/\/[^\/]+/)[0] + '/',
      }
    });
  } catch (err) { return text('Fetch error: ' + err.message); }

  const hdrs = resp.getHeaders();
  const ct = (hdrs['Content-Type'] || hdrs['content-type'] || 'text/html').toLowerCase();

  if (ct.includes('text/html')) {
    const html = rewriteHtml(resp.getContentText('UTF-8'), targetUrl, proxyBase);
    return HtmlService.createHtmlOutput(html)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  if (ct.includes('text/css')) {
    return ContentService
      .createTextOutput(rewriteCss(resp.getContentText('UTF-8'), targetUrl, proxyBase))
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // Pass-through for JS and other text types
  return ContentService
    .createTextOutput(resp.getContentText('UTF-8'))
    .setMimeType(ContentService.MimeType.TEXT);
}

function text(msg) {
  return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT);
}

// ── Encoding ──────────────────────────────────────────────────────────────────

function encB64(str) {
  return Utilities.base64EncodeWebSafe(str).replace(/=/g, '');
}

function decB64(enc) {
  const pad = enc.length % 4;
  const padded = pad ? enc + '='.repeat(4 - pad) : enc;
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString('UTF-8');
}

// ── URL resolution (no URL class in Apps Script) ──────────────────────────────

function resolveAbs(val, baseUrl) {
  if (!val) return null;
  const v = val.trim();
  if (!v || /^(data:|blob:|javascript:|#|mailto:|tel:)/i.test(v)) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const m = baseUrl.match(/^(https?:\/\/[^\/]+)(\/[^?#]*)?/);
  if (!m) return null;
  const origin = m[1];
  const dir = (m[2] || '/').replace(/\/[^\/]*$/, '/');
  if (v.startsWith('//')) return 'https:' + v;
  if (v.startsWith('/')) return origin + v;
  return origin + dir + v;
}

function toProxy(val, baseUrl, proxyBase) {
  const abs = resolveAbs(val, baseUrl);
  return abs ? proxyBase + '?u=' + encB64(abs) : val;
}

// ── HTML rewriter ─────────────────────────────────────────────────────────────

function rewriteHtml(html, targetUrl, proxyBase) {
  function rtp(val) { return toProxy(val, targetUrl, proxyBase); }

  html = html.replace(
    /(\s(?:src|href|action|poster|formaction|data-src))\s*=\s*(['"])(.*?)\2/gi,
    function(m, attr, q, val) {
      if (val.startsWith('#')) return m;
      const rw = rtp(val);
      return rw !== val ? attr + '=' + q + rw + q : m;
    }
  );

  html = html.replace(
    /(\ssrcset)\s*=\s*(['"])(.*?)\2/gi,
    function(m, attr, q, val) {
      const rw = val.split(',').map(function(part) {
        const t = part.trim();
        const si = t.search(/\s/);
        if (si === -1) return rtp(t);
        return rtp(t.slice(0, si)) + t.slice(si);
      }).join(', ');
      return attr + '=' + q + rw + q;
    }
  );

  html = html.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, function(m, q, val) {
    if (!val || val.startsWith('data:')) return m;
    return 'url(' + q + toProxy(val, targetUrl, proxyBase) + q + ')';
  });

  html = html.replace(/<meta[^>]+http-equiv\s*=\s*['"]content-security-policy['"][^>]*>/gi, '');

  const origin = (targetUrl.match(/^(https?:\/\/[^\/]+)/) || ['', ''])[1];

  // Runtime patch: rewrites fetch/XHR in-page so sub-requests also go through proxy
  const patch = '<script>(function(){' +
    'var W="' + proxyBase + '?u=",B="' + origin + '";' +
    'function enc(s){' +
      'try{' +
        'var b=unescape(encodeURIComponent(s));' +
        'var ch="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";' +
        'var o="",i=0;' +
        'while(i<b.length){var a=b.charCodeAt(i++),c=i<b.length?b.charCodeAt(i++):0,d=i<b.length?b.charCodeAt(i++):0;' +
        'o+=ch[a>>2]+ch[((a&3)<<4)|(c>>4)]+ch[((c&15)<<2)|(d>>6)]+ch[d&63];}' +
        'var p=b.length%3;return(p?o.slice(0,p-3):o).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"");' +
      '}catch(e){return s;}}' +
    'function rw(u){' +
      'if(!u||typeof u!=="string")return u;' +
      'var s=u.trim();' +
      'if(!s||/^(data:|blob:|javascript:|#)/.test(s))return s;' +
      'if(s.indexOf(W)===0)return s;' +
      'try{return W+enc(new URL(s,B).href);}catch(e){return u;}}' +
    'var oF=window.fetch;' +
    'window.fetch=function(r,o){return oF.call(this,typeof r==="string"?rw(r):r,o);};' +
    'var oO=XMLHttpRequest.prototype.open;' +
    'XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=rw(u);return oO.apply(this,a);};' +
    '})();<\/script>';

  html = html.replace(/<head([^>]*)>/i, '<head$1>' + patch);
  return html;
}

// ── CSS rewriter ──────────────────────────────────────────────────────────────

function rewriteCss(css, targetUrl, proxyBase) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, function(m, q, val) {
    if (!val || val.startsWith('data:')) return m;
    return 'url(' + q + toProxy(val, targetUrl, proxyBase) + q + ')';
  });
}

// ── Home page ─────────────────────────────────────────────────────────────────

function buildHomePage(proxyBase) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Proxy</title>' +
    '<style>' +
      '*{box-sizing:border-box;margin:0;padding:0}' +
      'body{min-height:100vh;background:#05070c;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1rem;font-family:sans-serif;}' +
      '.row{display:flex;gap:.55rem;width:min(36rem,100%);}' +
      'input{flex:1;padding:.82rem .9rem;border-radius:.65rem;border:1px solid rgba(39,48,68,.98);background:rgba(3,5,10,.92);color:#f5f7fb;font-size:.9rem;outline:none;min-width:0;transition:border-color .2s;}' +
      'input:focus{border-color:rgba(69,113,255,.95);}' +
      'input::placeholder{color:#566174;}' +
      'button{padding:.82rem 1.4rem;border-radius:.65rem;background:linear-gradient(180deg,#4f83ff 0%,#3c68ea 100%);border:1px solid rgba(100,141,255,.95);color:#fff;font-size:.9rem;font-weight:700;cursor:pointer;}' +
    '</style>' +
    '</head><body>' +
    '<div class="row">' +
      '<input id="u" type="url" placeholder="https://example.com" autocomplete="off" spellcheck="false">' +
      '<button onclick="go()">Go</button>' +
    '</div>' +
    '<script>' +
      'function enc(s){return btoa(unescape(encodeURIComponent(s))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"");}' +
      'function go(){' +
        'var t=document.getElementById("u").value.trim();' +
        'if(!t)return;' +
        'if(!/^https?:\\/\\//i.test(t))t="https://"+t;' +
        'try{new URL(t);}catch(e){return;}' +
        'window.location.href="' + proxyBase + '?u="+enc(t);' +
      '}' +
      'document.getElementById("u").addEventListener("keydown",function(e){if(e.key==="Enter")go();});' +
    '<\/script>' +
    '</body></html>';
}
