// ── Runtime interception ─────────────────────────────────────────────────────
// Started at document_start so we capture everything before page code runs.

const _intercepted = new Map(); // url -> { method, body, headers }

// Fetch
const _origFetch = window.fetch;
window.fetch = function (...args) {
  try {
    let url, method = 'GET', body = null, headers = {};
    if (args[0] instanceof Request) {
      url  = args[0].url;
      method = args[0].method || 'GET';
      args[0].headers.forEach((v, k) => { headers[k] = v; });
    } else {
      url = String(args[0]);
      if (args[1]) {
        method = (args[1].method || 'GET').toUpperCase();
        const raw = args[1].body;
        if (typeof raw === 'string') { try { body = JSON.parse(raw); } catch { body = raw; } }
        const h = args[1].headers;
        if (h) {
          if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
          else Object.assign(headers, h);
        }
      }
    }
    if (!_intercepted.has(url)) _intercepted.set(url, { method: method.toUpperCase(), body, headers });
    else if (!_intercepted.get(url).body && body) _intercepted.get(url).body = body;
  } catch (_) {}
  return _origFetch.apply(this, args);
};

// XHR — capture both url/method (open) and body (send)
const _origOpen = XMLHttpRequest.prototype.open;
const _origSend = XMLHttpRequest.prototype.send;
const _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  try {
    this._apinya = { url: String(url), method: (method || 'GET').toUpperCase(), headers: {} };
    if (!_intercepted.has(this._apinya.url))
      _intercepted.set(this._apinya.url, { method: this._apinya.method, body: null, headers: {} });
  } catch (_) {}
  return _origOpen.apply(this, [method, url, ...rest]);
};

XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
  try { if (this._apinya) this._apinya.headers[k] = v; } catch (_) {}
  return _origSetHeader.apply(this, arguments);
};

XMLHttpRequest.prototype.send = function (body) {
  try {
    if (this._apinya && body) {
      let parsed = body;
      if (typeof body === 'string') { try { parsed = JSON.parse(body); } catch {} }
      const entry = _intercepted.get(this._apinya.url);
      if (entry) {
        if (!entry.body) entry.body = parsed;
        Object.assign(entry.headers, this._apinya.headers || {});
      }
    }
  } catch (_) {}
  return _origSend.apply(this, arguments);
};

// WebSocket
const _OrigWS = window.WebSocket;
if (_OrigWS) {
  window.WebSocket = function (url, ...args) {
    try { if (!_intercepted.has(String(url))) _intercepted.set(String(url), { method: 'WS', body: null, headers: {} }); } catch (_) {}
    return new _OrigWS(url, ...args);
  };
  Object.assign(window.WebSocket, _OrigWS);
}

// ── Module-level caches (populated after runStaticScan) ──────────────────────
let _cachedScripts = [];
let _urlToVars     = new Map(); // url -> Set<varName>

// ── Helpers ──────────────────────────────────────────────────────────────────
const SKIP_EXTS = /\.(js|css|html?|png|jpe?g|gif|ico|svg|woff2?|ttf|eot|map|txt|pdf|zip|webp|avif)(\?.*)?$/i;

function looksLikeEndpoint(url) {
  if (!url || url.length < 4) return false;
  if (url === '/' || url === '//') return false;
  if (SKIP_EXTS.test(url)) return false;
  if (url.startsWith('/')) {
    const segs = url.replace(/[?#].*/, '').split('/').filter(Boolean);
    if (segs.length < 2) return false;
  }
  return true;
}

// ── Constant folding ──────────────────────────────────────────────────────────
function buildConstantMap(code) {
  const consts = new Map();
  const DIRECT = /\b([A-Za-z_$][A-Za-z0-9_$]{0,40})\s*=\s*["']((?:https?:\/\/[^\s"']{6,}|\/[a-zA-Z][^"'\n]{2,}))["']/g;
  let m;
  while ((m = DIRECT.exec(code)) !== null) {
    if (!SKIP_EXTS.test(m[2])) consts.set(m[1], m[2]);
  }
  for (let pass = 0; pass < 4; pass++) {
    let progress = false;
    const TMPL = /\b([A-Za-z_$][A-Za-z0-9_$]{0,40})\s*=\s*(?:[a-zA-Z_$]\w*\s*=>\s*)?`([^`\n]{3,})`/g;
    while ((m = TMPL.exec(code)) !== null) {
      if (consts.has(m[1])) continue;
      let r = m[2];
      let changed = false;
      for (const [cn, cv] of consts) {
        if (r.includes(`\${${cn}}`)) { r = r.split(`\${${cn}}`).join(cv); changed = true; }
      }
      if (!changed) continue;
      const wp = r.replace(/\$\{[^}]+\}/g, '{*}');
      if (!SKIP_EXTS.test(wp)) {
        if (!wp.includes('{*}') && (wp.startsWith('/') || wp.startsWith('http'))) {
          consts.set(m[1], wp); progress = true;
        }
      }
    }
    const CONCAT = /\b([A-Za-z_$][A-Za-z0-9_$]{0,40})\s*=\s*([A-Za-z_$][A-Za-z0-9_$]{0,40})\s*\+\s*["'`]([^"'`\n]+)["'`]/g;
    while ((m = CONCAT.exec(code)) !== null) {
      if (consts.has(m[1]) || !consts.has(m[2])) continue;
      const r = consts.get(m[2]) + m[3];
      if (!SKIP_EXTS.test(r)) { consts.set(m[1], r); progress = true; }
    }
    if (!progress) break;
  }
  return consts;
}

function endpointsFromConstants(code, consts) {
  const found = new Map();
  for (const [, cv] of consts) if (looksLikeEndpoint(cv)) found.set(cv, 'GET');
  const ALL_TMPL = /`([^`\n]{3,})`/g;
  let m;
  while ((m = ALL_TMPL.exec(code)) !== null) {
    let r = m[1]; let changed = false;
    for (const [cn, cv] of consts) {
      if (r.includes(`\${${cn}}`)) { r = r.split(`\${${cn}}`).join(cv); changed = true; }
    }
    if (!changed) continue;
    const wp = r.replace(/\$\{[^}]+\}/g, '{*}').trim();
    if (looksLikeEndpoint(wp)) found.set(wp, 'GET');
  }
  for (const [cn, cv] of consts) {
    const re = new RegExp(`\\b${cn.replace(/[$]/g,'\\$')}\\s*\\+\\s*["'\`]([^"'\`\\n]+)["'\`]`,'g');
    while ((m = re.exec(code)) !== null) {
      const r = cv + m[1];
      if (looksLikeEndpoint(r)) found.set(r, 'GET');
    }
  }
  return found;
}

function extractDirectPatterns(code) {
  const found = new Map();
  const add = (u, meth) => { if (looksLikeEndpoint(u) && !found.has(u)) found.set(u, meth); };
  const run = (re, meth) => { const r = new RegExp(re.source, re.flags); let m; while ((m = r.exec(code)) !== null) add(m[1].trim(), meth); };

  const METHOD_CTX = /\.\s*(get|post|put|delete|patch|head|options|request)\s*\(\s*["']((?:https?:\/\/[^"'#\s]{6,}|\/[a-zA-Z0-9_][^"'#\s]{2,}))["']/g;
  let mc; const r2 = new RegExp(METHOD_CTX.source, METHOD_CTX.flags);
  while ((mc = r2.exec(code)) !== null) add(mc[2].trim(), mc[1].toUpperCase());

  run(/\bfetch\s*\(\s*["']((?:https?:\/\/[^"'#\s]{6,}|\/[a-zA-Z0-9_][^"'#\s]{2,}))["']/g, 'GET');
  run(/\.open\s*\(\s*["']\w+["']\s*,\s*["']((?:https?:\/\/[^"'#\s]{6,}|\/[a-zA-Z0-9_][^"'#\s]{2,}))["']/g, 'GET');
  run(/sendBeacon\s*\(\s*["']((?:https?:\/\/[^"'#\s]{6,}|\/[a-zA-Z0-9_][^"'#\s]{2,}))["']/g, 'POST');
  run(/["'](?:url|baseURL|baseUrl|apiUrl|endpoint|uri|action)["']\s*:\s*["']((?:https?:\/\/[^"'#\s]{6,}|\/[a-zA-Z0-9_][^"'#\s]{2,}))["']/g, 'GET');
  for (const p of [
    /["'`](\/api\/[^"'`#\s?]{2,})["'`]/g, /["'`](\/v\d+\/[^"'`#\s?]{2,})["'`]/g,
    /["'`](\/graphql\/?[^"'`#\s?]*)["'`]/gi, /["'`](\/rest\/[^"'`#\s?]{2,})["'`]/g,
    /["'`](\/gql\/?[^"'`#\s?]*)["'`]/gi, /["'`](\/rpc\/[^"'`#\s?]{2,})["'`]/g,
    /["'`](\/trpc\/[^"'`#\s?]{2,})["'`]/g, /["'`](\/service[s]?\/[^"'`#\s?]{2,})["'`]/g,
    /["'`](https?:\/\/[^"'`#\s]{10,}\/(?:api|v\d+|graphql|rest|rpc|trpc)\/[^"'`#\s?]{2,})["'`]/g,
    /new\s+WebSocket\s*\(\s*["'`](wss?:\/\/[^"'`#\s]+)["'`]/g,
  ]) run(p, 'GET');

  // Template literals
  let m2;
  const METHOD_TMPL = /\.\s*(get|post|put|delete|patch|head|options|request)\s*\(\s*`([^`\n]+)`/gi;
  while ((m2 = METHOD_TMPL.exec(code)) !== null) {
    const p = m2[2].replace(/\$\{[^}]*\}/g, '{*}').trim();
    if (looksLikeEndpoint(p)) add(p, m2[1].toUpperCase());
  }
  const BARE_TMPL = /`(\/[a-zA-Z][a-zA-Z0-9_-]*\/[^`\n]{2,})`/g;
  while ((m2 = BARE_TMPL.exec(code)) !== null) {
    const p = m2[1].replace(/\$\{[^}]*\}/g, '{*}').trim();
    if (looksLikeEndpoint(p)) add(p, 'GET');
  }

  return found;
}

function extractFromCode(code) {
  const result = new Map();
  const merge = map => { for (const [u, m] of map) if (!result.has(u)) result.set(u, m); };
  const consts = buildConstantMap(code);
  merge(endpointsFromConstants(code, consts));
  merge(extractDirectPatterns(code));
  return result;
}

// ── Body schema extraction ────────────────────────────────────────────────────

const BODY_SKIP_KEYS = new Set([
  'true','false','null','undefined','return','new','this','delete','typeof','void',
  'if','else','for','while','do','switch','case','break','continue','catch',
  'const','let','var','function','class','async','await','import','export',
  'default','from','of','in','throw','try','finally','super','extends',
]);

function extractKeysFromObjStr(objStr, fields) {
  // Match `key:` pattern (object property keys always precede colon in JS)
  const KEY_RE = /\b([a-zA-Z_$][a-zA-Z0-9_$]{1,60})\s*:/g;
  let m;
  while ((m = KEY_RE.exec(objStr)) !== null) {
    const k = m[1];
    if (!BODY_SKIP_KEYS.has(k) && k.length > 1 && !/^[A-Z_]+$/.test(k)) fields.add(k);
  }
}

function getInterceptedEntry(url) {
  if (_intercepted.has(url)) return _intercepted.get(url);
  if (url.startsWith('/')) {
    try {
      const abs = window.location.origin + url;
      if (_intercepted.has(abs)) return _intercepted.get(abs);
    } catch (_) {}
  }
  if (url.startsWith('http')) {
    try {
      const path = new URL(url).pathname;
      if (_intercepted.has(path)) return _intercepted.get(path);
      // Try with search
      for (const [k, v] of _intercepted) {
        try { if (new URL(k).pathname === path) return v; } catch (_) {}
      }
    } catch (_) {}
  }
  return null;
}

function findBodyFields(url) {
  const fields = new Set();
  const varNames = _urlToVars.get(url) || new Set();

  // First: check dynamic captured body — most accurate
  const captured = getInterceptedEntry(url);
  if (captured?.body && typeof captured.body === 'object' && !Array.isArray(captured.body)) {
    for (const k of Object.keys(captured.body)) fields.add(k);
  }

  // Second: static analysis — search for call sites in cached scripts
  const searchTerms = [
    `"${url}"`, `'${url}'`, `\`${url}\``,
    ...varNames,
  ];

  for (const code of _cachedScripts) {
    for (const term of searchTerms) {
      let pos = 0;
      while ((pos = code.indexOf(term, pos)) !== -1) {
        // Search window: 400 before, 1200 after
        const ctx = code.slice(Math.max(0, pos - 400), Math.min(code.length, pos + 1200));

        // Pattern: .post/.put/.patch(..., { fields }) — 2nd arg is object literal
        // We look for the method call, skip the 1st arg, get the 2nd
        const MUTATION = /\.\s*(?:post|put|patch|request)\s*\(\s*(?:[^,{)]{0,200}),\s*(\{[^)]{0,800})/g;
        let m;
        while ((m = MUTATION.exec(ctx)) !== null) extractKeysFromObjStr(m[1], fields);

        // Pattern: data/body/params variable near the call site
        // const t={key1:x,key2:y}; .post(url, t)
        const VAR_OBJ = /\b(?:const|let|var)\s+([a-zA-Z_$]\w{0,30})\s*=\s*(\{[^}]{0,600}\})/g;
        while ((m = VAR_OBJ.exec(ctx)) !== null) {
          const [, varName, objStr] = m;
          // Check if this var is used in a mutation call nearby
          if (ctx.includes(`.post(`) || ctx.includes(`.put(`) || ctx.includes(`.patch(`)) {
            extractKeysFromObjStr(objStr, fields);
          }
        }

        pos++;
      }
    }
  }

  return [...fields];
}

// ── Auth context collection ───────────────────────────────────────────────────

function collectAuth() {
  const auth = { cookieStr: document.cookie, authorization: null, csrf: null, extraHeaders: {} };

  // CSRF token from meta tags (Laravel, Rails, Django, etc.)
  for (const sel of [
    'meta[name="csrf-token"]', 'meta[name="_token"]',
    'meta[name="X-CSRF-TOKEN"]', 'meta[name="csrf_token"]',
  ]) {
    const el = document.querySelector(sel);
    if (el?.content) { auth.csrf = el.content; break; }
  }

  // Tokens from localStorage / sessionStorage
  const TOKEN_NAME_RE = /token|auth|jwt|bearer|access|refresh|credential|session/i;
  for (const store of [localStorage, sessionStorage]) {
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k) continue;
        const v = store.getItem(k);
        if (!v || v.length < 10) continue;
        if (TOKEN_NAME_RE.test(k)) {
          if (!auth.authorization && v.startsWith('eyJ')) {
            auth.authorization = `Bearer ${v}`;
          } else if (!auth.extraHeaders[k]) {
            auth.extraHeaders[k] = v.length > 200 ? v.slice(0, 200) + '…' : v;
          }
        }
      }
    } catch (_) {}
  }

  // Common SPA global patterns (Redux store, Zustand, window globals)
  try {
    const candidates = [
      () => window.__REDUX_STATE__,
      () => window.__store__?.getState?.(),
      () => window.store?.getState?.(),
      () => window.reduxStore?.getState?.(),
      () => window.__AUTH__,
      () => window.__USER__,
    ];
    for (const fn of candidates) {
      try {
        const s = fn();
        if (!s) continue;
        const token = s?.auth?.token || s?.auth?.accessToken || s?.authentication?.token
          || s?.user?.token || s?.session?.token || s?.token;
        if (token && !auth.authorization) { auth.authorization = `Bearer ${token}`; break; }
      } catch (_) {}
    }
  } catch (_) {}

  return auth;
}

// ── Page scan ─────────────────────────────────────────────────────────────────

async function runStaticScan() {
  const resultMap = new Map();
  const scriptEls = [...document.querySelectorAll('script')];
  const contents = [];

  for (const el of scriptEls) {
    if (el.textContent) contents.push(el.textContent);
  }

  const externalUrls = scriptEls.filter(s => s.src).map(s => s.src);
  const fetched = await Promise.allSettled(
    externalUrls.map(u => fetch(u, { cache: 'force-cache' }).then(r => r.text()))
  );
  for (const r of fetched) {
    if (r.status === 'fulfilled' && r.value) contents.push(r.value);
  }

  // Store globally for later CRAFT_REQUEST queries
  _cachedScripts = contents;
  _urlToVars = new Map();

  for (const code of contents) {
    const consts = buildConstantMap(code);
    for (const [varName, url] of consts) {
      if (looksLikeEndpoint(url)) {
        if (!_urlToVars.has(url)) _urlToVars.set(url, new Set());
        _urlToVars.get(url).add(varName);
      }
    }
    for (const [u, method] of extractFromCode(code)) {
      if (!resultMap.has(u)) resultMap.set(u, method);
    }
  }

  // HTML attributes
  document.querySelectorAll('[action],[data-url],[data-endpoint],[data-href],[data-api]').forEach(el => {
    ['action','data-url','data-endpoint','data-href','data-api'].forEach(attr => {
      const v = el.getAttribute(attr);
      if (v && looksLikeEndpoint(v) && !resultMap.has(v)) resultMap.set(v, 'GET');
    });
  });

  return [...resultMap.entries()].map(([url, method]) => ({ url, method }));
}

function getPerformanceUrls() {
  const SKIP = /\.(png|jpe?g|gif|ico|css|woff2?|ttf|eot|svg|mp4|webm|mp3|wav|pdf|map)(\?.*)?$/i;
  return performance.getEntriesByType('resource').map(e => e.name).filter(u => !SKIP.test(u));
}

// ── Message handlers ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SCAN') {
    runStaticScan().then(staticItems => {
      sendResponse({
        static: staticItems,
        dynamic: [..._intercepted.entries()].map(([url, d]) => ({ url, method: d.method })),
        performance: getPerformanceUrls(),
      });
    });
    return true;
  }

  if (msg.type === 'CRAFT_REQUEST') {
    const url = msg.url;
    const bodyFields = findBodyFields(url);
    const captured = getInterceptedEntry(url);
    const auth = collectAuth();
    sendResponse({
      auth,
      bodyFields,
      capturedBody:   captured?.body   || null,
      capturedMethod: captured?.method || null,
      capturedHeaders: captured?.headers || {},
    });
    return true;
  }

  if (msg.type === 'GET_CODE_CONTEXT') {
    const { url, mode } = msg;

    if (mode === 'batch') {
      // Batch mode: return HTTP-dense sections from all scripts for full-app analysis
      const HTTP_RE = /\.(?:get|post|put|delete|patch|request)\s*\(|fetch\s*\(|\.open\s*\(/g;
      const batchChunks = [];
      let batchTotal = 0;
      const BATCH_MAX = 20000;

      for (const code of _cachedScripts) {
        const positions = [];
        let bm;
        const re2 = new RegExp(HTTP_RE.source, 'g');
        while ((bm = re2.exec(code)) !== null) positions.push(bm.index);
        if (!positions.length) continue;
        // Merge overlapping 3KB windows around each HTTP call
        let merged = [];
        for (const p of positions) {
          const s = Math.max(0, p - 300), e = Math.min(code.length, p + 2000);
          if (merged.length && s <= merged[merged.length - 1][1]) {
            merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
          } else merged.push([s, e]);
        }
        for (const [s, e] of merged) {
          if (batchTotal >= BATCH_MAX) break;
          const chunk = code.slice(s, e);
          batchChunks.push(chunk);
          batchTotal += chunk.length;
        }
        if (batchTotal >= BATCH_MAX) break;
      }
      sendResponse({ chunks: batchChunks, total: batchTotal });
      return true;
    }

    // Single-endpoint mode — smart multi-level path matching
    const varNames = _urlToVars.get(url) || new Set();

    // Build search terms at multiple specificity levels:
    // /v1/accounts/copi24/wrapper → try exact, then /v1/accounts/, then /v1/
    const searchTerms = new Set([url, ...varNames]);
    const cleanUrl = url.replace(/\{[^}]+\}/g, ''); // strip {*} placeholders
    const segments = cleanUrl.replace(/^\//, '').split('/').filter(Boolean);
    // Add progressive prefixes (minimum 2 segments to avoid too-broad matches)
    for (let i = segments.length; i >= 2; i--) {
      searchTerms.add('/' + segments.slice(0, i).join('/'));
    }

    const chunks = [];
    let total = 0;
    const MAX_BYTES = 14000;

    for (const code of _cachedScripts) {
      for (const term of searchTerms) {
        if (term.length < 4) continue;
        let pos = code.indexOf(term, 0);
        while (pos !== -1 && total < MAX_BYTES) {
          const start = Math.max(0, pos - 800);
          const end   = Math.min(code.length, pos + 3500);
          const chunk = code.slice(start, end);
          if (!chunks.some(c => c === chunk)) {
            chunks.push(chunk);
            total += chunk.length;
          }
          pos = code.indexOf(term, pos + 1);
        }
        if (total >= MAX_BYTES) break;
      }
      if (total >= MAX_BYTES) break;
    }
    sendResponse({ chunks, total });
    return true;
  }

  return false;
});
