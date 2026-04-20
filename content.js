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

// WebSocket — capture URL + first 20 messages in each direction
const _OrigWS = window.WebSocket;
if (_OrigWS) {
  window.WebSocket = function (url, ...args) {
    const wsUrl = String(url);
    const ws = new _OrigWS(url, ...args);
    try {
      if (!_intercepted.has(wsUrl))
        _intercepted.set(wsUrl, { method: 'WS', body: null, headers: {}, wsMessages: [] });
      const entry = _intercepted.get(wsUrl);
      const origSend = ws.send.bind(ws);
      ws.send = function (data) {
        try {
          if (entry.wsMessages.length < 20)
            entry.wsMessages.push({ dir: 'out', data: typeof data === 'string' ? data.slice(0, 300) : '[binary]' });
        } catch (_) {}
        return origSend(data);
      };
      ws.addEventListener('message', (evt) => {
        try {
          if (entry.wsMessages.length < 20)
            entry.wsMessages.push({ dir: 'in', data: typeof evt.data === 'string' ? evt.data.slice(0, 300) : '[binary]' });
        } catch (_) {}
      });
    } catch (_) {}
    return ws;
  };
  Object.assign(window.WebSocket, _OrigWS);
}

// ── Module-level caches (populated after runStaticScan) ──────────────────────
let _cachedScripts = [];
let _urlToVars     = new Map(); // url -> Set<varName>

// ── Helpers ──────────────────────────────────────────────────────────────────
const SKIP_EXTS = /\.(js|css|html?|png|jpe?g|gif|ico|svg|woff2?|ttf|eot|map|txt|pdf|zip|webp|avif)(\?.*)?$/i;

// Single-segment paths that are commonly high-value targets
const IMPORTANT_PATHS = /^\/(?:login|logout|signin|signup|register|token|refresh|auth|oauth2?|authorize|callback|me|profile|whoami|health|status|ping|graphql|gql|introspect|reset|verify|confirm|session|admin|dashboard|api|upload|download)(?:[/?#].*)?$/i;

function looksLikeEndpoint(url) {
  if (!url || url.length < 4) return false;
  if (url === '/' || url === '//') return false;
  if (SKIP_EXTS.test(url)) return false;
  if (url.startsWith('/')) {
    if (IMPORTANT_PATHS.test(url)) return true;
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

// ── Source map fetching ───────────────────────────────────────────────────────
// Many prod bundles embed //# sourceMappingURL= pointing to original source.
async function tryFetchSourceMap(scriptUrl, code) {
  const match = code.match(/\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/m);
  if (!match) return null;
  const ref = match[1].trim();
  try {
    if (ref.startsWith('data:application/json')) {
      const b64 = ref.split('base64,')[1];
      if (b64) return JSON.parse(atob(b64));
      return null;
    }
    const mapUrl = new URL(ref, scriptUrl).href;
    const res = await fetch(mapUrl, { cache: 'force-cache' });
    if (res.ok) return await res.json();
  } catch (_) {}
  return null;
}

// ── Secrets / credential detection ───────────────────────────────────────────
// ── Secret / credential detection patterns ───────────────────────────────────
// Strategy: two layers
//   1. Format-specific patterns (very high confidence, e.g. AKIA…, AIza…)
//   2. Property-name-based patterns: match ANY site's credential fields by name,
//      regardless of value format — covers accessKey, secretKey, S3_SECRET_KEY, etc.
//
// Values use [^"'`\r\n]{N,} to allow special chars (#!@$) and short values.

const _SECRET_PATTERNS = [

  // ── Layer 1: format-specific ──────────────────────────────────────────────
  { name: 'AWS AccessKeyId',        re: /\b(AKIA[0-9A-Z]{16})\b/g },
  { name: 'Google/Firebase Key',    re: /["'`](AIza[A-Za-z0-9_-]{30,50})["'`]/g },
  { name: 'Firebase measurementId', re: /["'`](G-[A-Z0-9]{8,14})["'`]/g },
  { name: 'Firebase apiKey prop',   re: /\bapiKey\s*[:=]\s*["'`]([A-Za-z0-9_-]{15,})["'`]/gi },
  { name: 'Stripe Live SK',         re: /\b(sk_live_[0-9a-zA-Z]{24,})\b/g },
  { name: 'Stripe Live PK',         re: /\b(pk_live_[0-9a-zA-Z]{24,})\b/g },
  { name: 'GitHub Token',           re: /\b(gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{20,})\b/g },
  { name: 'Slack Token',            re: /\b(xox[baprs]-[0-9]{10,}-[0-9A-Za-z-]{20,})\b/g },
  { name: 'Firebase FCM',           re: /\b(AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{100,})\b/g },
  { name: 'Private Key header',     re: /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g },
  { name: 'Twilio SID',             re: /\b(SK[0-9a-fA-F]{32})\b/g },
  { name: 'Hardcoded JWT',          re: /["'`](eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,})["'`]/g },

  // ── Layer 2a: SPA env vars (REACT_APP_*, VITE_*, NEXT_PUBLIC_*) ───────────
  // [A-Z0-9_]* allows digits so S3_SECRET_KEY, GRPC_V2_TOKEN, etc. all match.
  // Value: [^"'`\r\n]{4,} — any non-quote char, min 4, allows # ! @ $ etc.
  { name: 'SPA env credential',
    re: /\b(?:REACT_APP|VITE|NEXT_PUBLIC)_[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PWD|CREDENTIAL|CERT)[A-Z0-9_]*\s*["'`:\s,=]+["'`]([^"'`\r\n]{4,})["'`]/g },

  // Internal service URLs baked into the bundle — useful for infra recon
  { name: 'Internal service URL',
    re: /\b(?:REACT_APP|VITE|NEXT_PUBLIC)_[A-Z0-9_]*(?:URL|HOST|ENDPOINT|BASE)[A-Z0-9_]*\s*["'`:\s,=]+["'`](https?:\/\/[^"'`\s\r\n]{8,})["'`]/g },

  // ── Layer 2b: property-name-based — covers any framework, any site ─────────
  // Explicit alternation of sensitive property names in camelCase + snake_case.
  // Non-capturing groups throughout so m[1] is always the value.
  // [_-] at END of char class = literal hyphen, not a range.

  { name: 'Access / Secret key prop',
    re: /["'`]?(?:access[_-]?key|secret[_-]?key|accessKey|secretKey)["'`]?\s*[:=]\s*["'`]([^"'`\r\n]{4,200})["'`]/gi },

  { name: 'API key / secret prop',
    re: /["'`]?(?:api[_-]?key|api[_-]?secret|apiKey|apiSecret|app[_-]?key|app[_-]?secret|appKey|appSecret)["'`]?\s*[:=]\s*["'`]([^"'`\r\n]{4,200})["'`]/gi },

  { name: 'Auth / token prop',
    re: /["'`]?(?:auth[_-]?token|auth[_-]?key|auth[_-]?secret|authToken|authKey|authSecret|client[_-]?secret|clientSecret|bearer[_-]?token|bearerToken|refresh[_-]?token|refreshToken)["'`]?\s*[:=]\s*["'`]([^"'`\r\n]{4,200})["'`]/gi },

  { name: 'Private / signing key prop',
    re: /["'`]?(?:private[_-]?key|signing[_-]?key|encryption[_-]?key|hmac[_-]?(?:key|secret)|master[_-]?(?:key|secret)|webhook[_-]?(?:key|secret|token)|privateKey|signingKey|encryptionKey|masterKey)["'`]?\s*[:=]\s*["'`]([^"'`\r\n]{4,200})["'`]/gi },

  { name: 'Password / passwd prop',
    re: /["'`]?(?:password|passwd|passphrase|pwd)["'`]?\s*[:=]\s*["'`]([^"'`\r\n]{4,200})["'`]/gi },

  { name: 'DB / storage credential',
    re: /["'`]?(?:(?:db|database|mongo|redis|mysql|postgres|pg)[_-]?(?:pass(?:word)?|secret|url)|s3[_-]?(?:access[_-]?key|secret[_-]?key|key|secret)|smtp[_-]?(?:pass(?:word)?|secret)|ftp[_-]?(?:pass(?:word)?|secret))["'`]?\s*[:=]\s*["'`]([^"'`\r\n]{4,200})["'`]/gi },

  { name: 'MQTT credential',
    re: /["'`]?mqtt[_-]?(?:user(?:name)?|pass(?:word)?|token)["'`]?\s*[:=]\s*["'`]([^"'`\r\n]{4,200})["'`]/gi },
];

// Filter obvious placeholder / test values.
// \b prevents "latest" matching "test", "replacement" matching "replace", etc.
const _PLACEHOLDER = /\byour[\s_-]|\breplace\b|\bexample\b|\bplaceholder\b|x{4,}|\btest\b|\bdemo\b|\bsample\b|\bchangeme\b|^<|^>|^\d+$|^#[0-9a-fA-F]{3,8}$/i;

function detectSecrets(codes) {
  const findings = [];
  const seen = new Set();
  for (const code of codes) {
    for (const { name, re } of _SECRET_PATTERNS) {
      const r = new RegExp(re.source, re.flags);
      let m;
      while ((m = r.exec(code)) !== null) {
        const value = (m[1] || m[0]).slice(0, 120);
        if (_PLACEHOLDER.test(value)) continue;
        const key = `${name}:${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Short preview (single line)
        const ctx = code.slice(Math.max(0, m.index - 60), Math.min(code.length, m.index + 80))
          .replace(/\s+/g, ' ').trim();
        // Full context for expand view: add newlines at JS delimiters so minified
        // code becomes somewhat readable. Cap at ~800 chars total.
        const raw = code.slice(Math.max(0, m.index - 250), Math.min(code.length, m.index + 550));
        const fullContext = raw
          .replace(/([,;{}])\s*/g, '$1\n')
          .replace(/\n{2,}/g, '\n')
          .trim()
          .slice(0, 800);
        findings.push({ type: name, value, context: ctx, fullContext });
      }
    }
  }
  return findings;
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
  const sourceMapFiles = [];

  for (const el of scriptEls) {
    if (el.textContent) contents.push(el.textContent);
  }

  const externalUrls = scriptEls.filter(s => s.src).map(s => s.src);
  const fetched = await Promise.allSettled(
    externalUrls.map(u => fetch(u, { cache: 'force-cache' }).then(r => r.text()))
  );
  for (let i = 0; i < fetched.length; i++) {
    const r = fetched[i];
    if (r.status !== 'fulfilled' || !r.value) continue;
    contents.push(r.value);
    // Try to fetch and parse source map — exposes original unminified source
    try {
      const mapData = await tryFetchSourceMap(externalUrls[i], r.value);
      if (mapData) {
        if (mapData.sources) {
          for (const s of mapData.sources) {
            if (s && !s.includes('node_modules') && !s.startsWith('webpack:///external')) {
              sourceMapFiles.push(s.replace(/^webpack:\/\/\//, ''));
            }
          }
        }
        // Original source code is gold — scan it for endpoints
        if (mapData.sourcesContent) {
          for (const src of mapData.sourcesContent) {
            if (src && src.length < 500000) contents.push(src);
          }
        }
      }
    } catch (_) {}
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

  // robots.txt — Disallowed paths are often the most interesting ones
  try {
    const robotsRes = await fetch(window.location.origin + '/robots.txt', { cache: 'force-cache' });
    if (robotsRes.ok) {
      for (const line of (await robotsRes.text()).split('\n')) {
        const m = line.match(/^Disallow:\s*(\S+)/);
        if (!m || m[1] === '/') continue;
        const p = m[1].split('*')[0]; // strip wildcard suffix
        if (p && looksLikeEndpoint(p) && !resultMap.has(p)) resultMap.set(p, 'GET');
      }
    }
  } catch (_) {}

  const secrets = detectSecrets(contents);

  return {
    endpoints: [...resultMap.entries()].map(([url, method]) => ({ url, method })),
    secrets,
    sourceMapFiles,
  };
}

function getPerformanceUrls() {
  const SKIP = /\.(png|jpe?g|gif|ico|css|woff2?|ttf|eot|svg|mp4|webm|mp3|wav|pdf|map)(\?.*)?$/i;
  return performance.getEntriesByType('resource').map(e => e.name).filter(u => !SKIP.test(u));
}

// ── Message handlers ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SCAN') {
    runStaticScan().then(({ endpoints, secrets, sourceMapFiles }) => {
      sendResponse({
        static: endpoints,
        dynamic: [..._intercepted.entries()].map(([url, d]) => ({
          url, method: d.method,
          wsMessages: d.wsMessages?.length ? d.wsMessages : undefined,
        })),
        performance: getPerformanceUrls(),
        secrets,
        sourceMapFiles,
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
