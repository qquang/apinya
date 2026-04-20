let allData = { all: [], network: [], dynamic: [], static: [], secrets: [], sourceMapFiles: [] };
let currentTab = 'all';
let hostOnly = true;
let currentRootDomain = '';
let currentTabHostname = '';

// Detail view state
let detailItem   = null;  // { url, method, src }
let detailCraft  = null;  // response from CRAFT_REQUEST
let detailMethod = 'GET'; // currently selected method in detail view

// Known 2-part SLDs (e.g. .com.vn, .co.uk) — need 3 parts for root domain
const TWO_PART_SLDS = new Set([
  'com.vn','net.vn','org.vn','edu.vn','gov.vn','int.vn',
  'co.uk','me.uk','org.uk','net.uk','gov.uk',
  'com.au','net.au','org.au','edu.au','gov.au',
  'co.jp','ne.jp','or.jp','ac.jp','go.jp',
  'com.br','net.br','org.br','edu.br','gov.br',
  'co.nz','net.nz','org.nz','edu.nz','govt.nz',
  'co.kr','or.kr','ne.kr','re.kr',
  'com.tw','net.tw','org.tw','edu.tw','gov.tw',
  'com.sg','net.sg','org.sg','edu.sg','gov.sg',
  'com.hk','net.hk','org.hk','edu.hk','gov.hk',
]);

function getRootDomain(hostname) {
  if (!hostname) return '';
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const last2 = parts.slice(-2).join('.');
  return TWO_PART_SLDS.has(last2) ? parts.slice(-3).join('.') : last2;
}

function isTargetDomain(url, rootDomain) {
  if (!rootDomain) return true;
  // Relative paths always belong to main domain
  if (/^\/(?!\/)/.test(url)) return true;
  try {
    const h = new URL(url).hostname;
    return h === rootDomain || h.endsWith('.' + rootDomain);
  } catch {
    return url.startsWith('/');
  }
}

function applyHostFilter(items) {
  if (!hostOnly || !currentRootDomain) return items;
  return items.filter(i => isTargetDomain(i.url, currentRootDomain));
}

function statusBadge(status) {
  if (!status) return '';
  const cls = status >= 500 ? 's-5xx' : status >= 400 ? 's-4xx' : status >= 300 ? 's-3xx' : 's-2xx';
  return `<span class="status-badge ${cls}">${status}</span>`;
}

const $ = id => document.getElementById(id);

// DOM refs
const listBtn     = $('listBtn');
const clearBtn    = $('clearBtn');
const statusEl    = $('status');
const tabsEl      = $('tabs');
const toolbarEl   = $('toolbar');
const resultsEl   = $('results');
const listEl      = $('list');
const emptyEl     = $('empty');
const filterInput = $('filterInput');
const copyAllBtn    = $('copyAllBtn');
const exportJsonBtn = $('exportJsonBtn');
const hostBtn       = $('hostBtn');
const aiBtn         = $('aiBtn');
const mainView    = $('mainView');
const detailView  = $('detailView');
const aiView      = $('aiView');
const backBtn     = $('backBtn');
const detailTitle = $('detailTitle');
const analysingEl = $('analysing');
const burpTextarea = $('burpTextarea');
const copyBurpBtn  = $('copyBurpBtn');
const copyCurlBtn  = $('copyCurlBtn');
const fieldHint    = $('fieldHint');


function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
  statusEl.classList.remove('hidden');
}

function updateCounts() {
  $('cnt-all').textContent     = applyHostFilter(allData.all).length;
  $('cnt-network').textContent = applyHostFilter(allData.network).length;
  $('cnt-dynamic').textContent = applyHostFilter(allData.dynamic).length;
  $('cnt-static').textContent  = applyHostFilter(allData.static).length;
  $('cnt-secrets').textContent = (allData.secrets || []).length;
}

function methodClass(method) {
  const m = (method || 'UNK').toUpperCase();
  if (m.startsWith('WS')) return 'm-WS';
  if (['GET','POST','PUT','DELETE','PATCH'].includes(m)) return `m-${m}`;
  return 'm-UNK';
}

function srcClass(src) {
  return { N: 'src-N', D: 'src-D', S: 'src-S' }[src] || '';
}

function srcLabel(src) {
  return { N: 'NET', D: 'DYN', S: 'SRC' }[src] || src;
}

function render(items) {
  items = applyHostFilter(items);
  const filter = filterInput.value.trim().toLowerCase();
  const filtered = filter ? items.filter(i => i.url.toLowerCase().includes(filter)) : items;

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    resultsEl.classList.add('hidden');
    return;
  }

  emptyEl.classList.add('hidden');
  resultsEl.classList.remove('hidden');

  listEl.innerHTML = filtered.map((item) => `
    <li data-item="${escHtml(JSON.stringify(item))}" title="${escHtml(item.url)}">
      <span class="method-badge ${methodClass(item.method)}">${escHtml(item.method || '?')}</span>
      <span class="src-badge ${srcClass(item.src)}">${srcLabel(item.src)}</span>
      ${statusBadge(item.status)}
      <span class="url-text">${fmtUrl(item.url)}</span>
      <span class="copy-hint">burp</span>
    </li>
  `).join('');

  listEl.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => {
      try { openDetailView(JSON.parse(li.dataset.item)); } catch (_) {}
    });
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Show end of URL: "…/last/part/of/path" so the meaningful filename is always visible
function fmtUrl(url) {
  const MAX = 54;
  if (url.length <= MAX) return escHtml(url);
  return `<span class="url-dim">…</span>${escHtml(url.slice(-(MAX)))}`;
}

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  const secretsPanel = $('secretsPanel');
  if (tab === 'secrets') {
    resultsEl.classList.add('hidden');
    emptyEl.classList.add('hidden');
    secretsPanel.classList.remove('hidden');
    renderSecrets();
  } else {
    secretsPanel.classList.add('hidden');
    render(allData[tab] || []);
  }
}

function renderSecrets() {
  const secretsList = $('secretsList');
  const secretsEmpty = $('secretsEmpty');
  const secrets = allData.secrets || [];
  if (secrets.length === 0) {
    secretsList.innerHTML = '';
    secretsEmpty.classList.remove('hidden');
    return;
  }
  secretsEmpty.classList.add('hidden');

  secretsList.innerHTML = secrets.map((s, i) => {
    // Highlight the credential value inside the expanded context
    const fullCtx = s.fullContext || s.context || '';
    const escapedCtx = escHtml(fullCtx);
    const escapedVal = escHtml(s.value);
    const highlightedCtx = escapedCtx.split(escapedVal).join(
      `<mark>${escapedVal}</mark>`
    );
    return `
    <li class="secret-item" data-idx="${i}">
      <div class="secret-header">
        <span class="secret-type">${escHtml(s.type)}</span>
        <button class="copy-secret-btn">COPY</button>
      </div>
      <div class="secret-value">${escHtml(s.value)}</div>
      <div class="secret-ctx-preview">
        <span class="secret-ctx-text">${escHtml((s.context || '').slice(0, 100))}</span>
        <span class="secret-toggle">▼ context</span>
      </div>
      <pre class="secret-ctx-expand">${highlightedCtx}</pre>
    </li>`;
  }).join('');

  secretsList.querySelectorAll('.secret-item').forEach(li => {
    // Toggle expanded context on preview row click
    li.querySelector('.secret-ctx-preview').addEventListener('click', () => {
      li.classList.toggle('secret-expanded');
      const t = li.querySelector('.secret-toggle');
      if (t) t.textContent = li.classList.contains('secret-expanded') ? '▲ collapse' : '▼ context';
    });

    // COPY button — stopPropagation so it doesn't trigger the toggle
    li.querySelector('.copy-secret-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(li.dataset.idx);
      const secret = allData.secrets[idx];
      if (!secret) return;
      const btn = e.currentTarget;
      navigator.clipboard.writeText(secret.value).then(() => {
        btn.textContent = 'OK!';
        setTimeout(() => { btn.textContent = 'COPY'; }, 1200);
      });
    });
  });
}

function dedupeUrls(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.url + '|' + item.method;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeUrl(raw, src, knownMethod) {
  const u = String(raw).trim();
  if (u.startsWith('ws://') || u.startsWith('wss://')) return { url: u, method: 'WS', src };
  const method = (knownMethod || 'GET').toUpperCase();
  return { url: u, method, src };
}

listBtn.addEventListener('click', async () => {
  listBtn.disabled = true;
  listBtn.classList.add('scanning');
  setStatus('scanning...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('no active tab');

    // Capture root domain and hostname for Burp request crafting
    try {
      const tabHostname = new URL(tab.url).hostname;
      currentTabHostname = tabHostname;
      currentRootDomain = getRootDomain(tabHostname);
      hostBtn.title = `Show only ${currentRootDomain} & subdomains`;
      if (hostOnly) hostBtn.textContent = `HOST: ${currentRootDomain}`;
    } catch { currentRootDomain = ''; currentTabHostname = ''; }

    // 1. Network requests from background
    const bgRes = await chrome.runtime.sendMessage({ type: 'GET_NETWORK', tabId: tab.id });
    const networkItems = (bgRes.data || []).map(r => ({
      url: r.url,
      method: (r.method || 'GET').toUpperCase(),
      src: 'N',
      status: r.status || null,
      resHeaders: r.resHeaders || null,
    }));

    // 2. Content script: static analysis + dynamic intercepted
    let contentRes = { static: [], dynamic: [], performance: [] };
    try {
      contentRes = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN' });
    } catch (e) {
      // Content script not injected yet (e.g. chrome:// pages)
      setStatus('cannot scan this page (restricted URL)', true);
    }

    // content.js now returns [{url, method}] for dynamic and static
    const dynamicItems = (contentRes.dynamic || []).map(r =>
      typeof r === 'object' ? { url: r.url, method: r.method || 'GET', src: 'D' }
                            : normalizeUrl(r, 'D'));
    const perfItems    = (contentRes.performance || []).map(u => normalizeUrl(u, 'N'));
    const staticItems  = (contentRes.static || []).map(r =>
      typeof r === 'object' ? { url: r.url, method: r.method || 'GET', src: 'S' }
                            : normalizeUrl(r, 'S'));

    // Merge network + performance (both are "NET" source)
    const mergedNetwork = dedupeUrls([...networkItems, ...perfItems]);
    const mergedDynamic = dedupeUrls(dynamicItems);
    const mergedStatic  = dedupeUrls(staticItems);

    // All combined, prioritize network > dynamic > static
    const allItems = dedupeUrls([...mergedNetwork, ...mergedDynamic, ...mergedStatic]);

    allData = {
      all:            allItems,
      network:        mergedNetwork,
      dynamic:        mergedDynamic,
      static:         mergedStatic,
      secrets:        contentRes.secrets || [],
      sourceMapFiles: contentRes.sourceMapFiles || [],
    };

    updateCounts();
    tabsEl.classList.remove('hidden');
    toolbarEl.classList.remove('hidden');
    showTab('all');

    const shown = applyHostFilter(allItems).length;
    const domainInfo = (hostOnly && currentRootDomain) ? ` — ${shown} from ${currentRootDomain}` : '';
    const secretsInfo = contentRes.secrets?.length ? ` · ${contentRes.secrets.length} leak(s)` : '';
    const mapInfo = contentRes.sourceMapFiles?.length ? ` · ${contentRes.sourceMapFiles.length} src map files` : '';
    setStatus(`found ${allItems.length} total${domainInfo}${secretsInfo}${mapInfo}`);

    chrome.runtime.sendMessage({
      type: 'CACHE_SCAN', tabId: tab.id,
      data: { allData, rootDomain: currentRootDomain, tabHostname: currentTabHostname },
    });
  } catch (err) {
    setStatus(`error: ${err.message}`, true);
  } finally {
    listBtn.disabled = false;
    listBtn.classList.remove('scanning');
  }
});

clearBtn.addEventListener('click', () => {
  allData = { all: [], network: [], dynamic: [], static: [], secrets: [], sourceMapFiles: [] };
  updateCounts();
  listEl.innerHTML = '';
  filterInput.value = '';
  tabsEl.classList.add('hidden');
  toolbarEl.classList.add('hidden');
  resultsEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
  $('secretsPanel').classList.add('hidden');
  statusEl.classList.add('hidden');
  statusEl.textContent = '';

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) {
      chrome.runtime.sendMessage({ type: 'CLEAR', tabId: tab.id });
      chrome.runtime.sendMessage({ type: 'CACHE_SCAN', tabId: tab.id, data: null });
    }
  });
});

filterInput.addEventListener('input', () => {
  render(allData[currentTab] || []);
});

copyAllBtn.addEventListener('click', () => {
  const items = allData[currentTab] || [];
  const filter = filterInput.value.trim().toLowerCase();
  const filtered = filter ? items.filter(i => i.url.toLowerCase().includes(filter)) : items;
  if (!filtered.length) return;
  const text = filtered.map(i => `${i.method}\t${i.url}`).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const orig = copyAllBtn.textContent;
    copyAllBtn.textContent = 'COPIED!';
    setTimeout(() => { copyAllBtn.textContent = orig; }, 1500);
  });
});

exportJsonBtn.addEventListener('click', () => {
  const data = {
    target: currentRootDomain || currentTabHostname || 'unknown',
    scanned_at: new Date().toISOString(),
    endpoints: allData.all.map(e => ({
      url: e.url,
      method: e.method,
      source: e.src,
      status: e.status || null,
      response_headers: e.resHeaders || null,
    })),
    secrets: allData.secrets || [],
    source_map_files: allData.sourceMapFiles || [],
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `apinya-${data.target}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

hostBtn.addEventListener('click', () => {
  hostOnly = !hostOnly;
  hostBtn.classList.toggle('active', hostOnly);
  hostBtn.textContent = (hostOnly && currentRootDomain) ? `HOST: ${currentRootDomain}` : 'HOST';
  updateCounts();
  render(allData[currentTab] || []);
  if (allData.all.length > 0) {
    const shown = applyHostFilter(allData.all).length;
    const domainInfo = (hostOnly && currentRootDomain) ? ` — ${shown} from ${currentRootDomain}` : ` — all ${allData.all.length}`;
    setStatus(`found ${allData.all.length} total${domainInfo} — click any for Burp request`);
  }
});

// ── Detail view ───────────────────────────────────────────────────────────────

function openDetailView(item) {
  detailItem   = item;
  detailCraft  = null;
  detailMethod = item.method === 'WS' ? 'GET' : (item.method || 'GET');

  // Show detail, hide main
  mainView.classList.add('hidden');
  detailView.classList.remove('hidden');

  // Update header
  const path = item.url.length > 46 ? '…' + item.url.slice(-46) : item.url;
  detailTitle.textContent = path;

  // Set active method button
  document.querySelectorAll('.mBtn').forEach(b => {
    b.classList.toggle('active', b.dataset.m === detailMethod);
  });

  // Show loading state
  burpTextarea.value = '';
  burpTextarea.disabled = true;
  analysingEl.classList.remove('hidden');
  fieldHint.classList.add('hidden');

  // Ask content script for auth + body schema
  chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
    if (!tab) { fallbackRender(); return; }
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'CRAFT_REQUEST', url: item.url });
      detailCraft = resp;
    } catch (_) {
      detailCraft = null;
    }
    analysingEl.classList.add('hidden');
    renderBurpRequest();
  });
}

function fallbackRender() {
  analysingEl.classList.add('hidden');
  detailCraft = null;
  renderBurpRequest();
}

function renderBurpRequest() {
  const item  = detailItem;
  const craft = detailCraft || {};
  const auth  = craft.auth || {};
  const bodyFields   = craft.bodyFields || [];
  const capturedBody = craft.capturedBody || null;

  burpTextarea.value = buildBurpRequest(item.url, detailMethod, currentTabHostname, auth, bodyFields, capturedBody);
  burpTextarea.disabled = false;

  // Show hint about body source + response headers
  const hints = [];
  if (capturedBody) hints.push(`body: captured (${Object.keys(capturedBody).length} fields)`);
  else if (bodyFields.length > 0) hints.push(`body: inferred — ${bodyFields.join(', ')}`);

  const rh = detailItem?.resHeaders;
  if (rh) {
    if (rh['access-control-allow-origin']) hints.push(`CORS: ${rh['access-control-allow-origin']}`);
    if (rh['server']) hints.push(`server: ${rh['server']}`);
    if (rh['x-powered-by']) hints.push(`powered-by: ${rh['x-powered-by']}`);
    if (rh['content-type']) hints.push(`ctype: ${rh['content-type'].split(';')[0]}`);
  }

  if (hints.length) {
    fieldHint.textContent = hints.join('  ·  ');
    fieldHint.classList.remove('hidden');
  } else {
    fieldHint.classList.add('hidden');
  }
}

function buildBurpRequest(url, method, hostname, auth, bodyFields, capturedBody) {
  let path = url, host = hostname || 'TARGET_HOST';
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try { const u = new URL(url); path = u.pathname + u.search; host = u.host; } catch (_) {}
  } else if (!hostname) {
    host = 'TARGET_HOST';
  }

  const lines = [];
  lines.push(`${method} ${path} HTTP/1.1`);
  lines.push(`Host: ${host}`);
  lines.push(`Accept: application/json, text/plain, */*`);
  lines.push(`Accept-Language: en-US,en;q=0.9`);
  lines.push(`Accept-Encoding: gzip, deflate, br`);

  if (['POST','PUT','PATCH'].includes(method)) lines.push(`Content-Type: application/json`);

  // Auth headers
  if (auth.authorization) lines.push(`Authorization: ${auth.authorization}`);
  if (auth.csrf)          lines.push(`X-CSRF-Token: ${auth.csrf}`);

  // Captured request headers (e.g. X-Requested-With, custom tokens)
  if (auth.extraHeaders) {
    for (const [k, v] of Object.entries(auth.extraHeaders)) {
      // Skip if already covered, skip obviously non-header values
      if (k.toLowerCase() === 'authorization') continue;
      if (v && v.length < 300) lines.push(`${k}: ${v}`);
    }
  }

  const cookies = (auth.cookieStr || '').trim();
  if (cookies) lines.push(`Cookie: ${cookies}`);

  lines.push(`Referer: https://${host}/`);
  lines.push(`Connection: close`);

  // Body
  if (['POST','PUT','PATCH'].includes(method)) {
    let body;
    if (capturedBody && typeof capturedBody === 'object') {
      body = JSON.stringify(capturedBody, null, 2);
    } else if (bodyFields.length > 0) {
      const obj = {};
      for (const f of bodyFields) obj[f] = '';
      body = JSON.stringify(obj, null, 2);
    } else {
      body = '{\n  \n}';
    }
    lines.push(`Content-Length: ${new TextEncoder().encode(body).length}`);
    lines.push('');
    lines.push(body);
  } else {
    // HTTP spec: headers must end with \r\n\r\n even for bodyless methods.
    // join('\r\n') with two trailing empty strings produces "last-header\r\n\r\n".
    lines.push('');
    lines.push('');
  }

  return lines.join('\r\n');
}

function buildCurl(url, method, hostname, auth, bodyFields, capturedBody) {
  let fullUrl = url;
  if (!url.startsWith('http')) fullUrl = `https://${hostname || 'TARGET_HOST'}${url}`;

  const parts = [`curl -s -X ${method} '${fullUrl}'`];
  parts.push(`  -H 'Accept: application/json'`);
  if (auth.authorization) parts.push(`  -H 'Authorization: ${auth.authorization}'`);
  if (auth.csrf)          parts.push(`  -H 'X-CSRF-Token: ${auth.csrf}'`);
  const cookies = (auth.cookieStr || '').trim();
  if (cookies) parts.push(`  -H 'Cookie: ${cookies}'`);

  if (['POST','PUT','PATCH'].includes(method)) {
    let body;
    if (capturedBody && typeof capturedBody === 'object') {
      body = JSON.stringify(capturedBody);
    } else if (bodyFields.length > 0) {
      const obj = {};
      for (const f of bodyFields) obj[f] = '';
      body = JSON.stringify(obj);
    } else {
      body = '{}';
    }
    parts.push(`  -H 'Content-Type: application/json'`);
    parts.push(`  -d '${body.replace(/'/g, "\\'")}'`);
  }

  return parts.join(' \\\n');
}

// Back to list
backBtn.addEventListener('click', () => {
  detailView.classList.add('hidden');
  mainView.classList.remove('hidden');
  detailItem = null;
  detailCraft = null;
});

// Method switcher
document.querySelectorAll('.mBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    detailMethod = btn.dataset.m;
    document.querySelectorAll('.mBtn').forEach(b => b.classList.toggle('active', b === btn));
    renderBurpRequest();
  });
});

// Copy Burp
copyBurpBtn.addEventListener('click', () => {
  const text = burpTextarea.value;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    copyBurpBtn.classList.add('flash');
    const orig = copyBurpBtn.textContent;
    copyBurpBtn.textContent = 'COPIED!';
    setTimeout(() => { copyBurpBtn.textContent = orig; copyBurpBtn.classList.remove('flash'); }, 1400);
  });
});

// Copy cURL
copyCurlBtn.addEventListener('click', () => {
  if (!detailItem) return;
  const craft = detailCraft || {};
  const text = buildCurl(
    detailItem.url, detailMethod, currentTabHostname,
    craft.auth || {}, craft.bodyFields || [], craft.capturedBody || null
  );
  navigator.clipboard.writeText(text).then(() => {
    copyCurlBtn.classList.add('flash');
    const orig = copyCurlBtn.textContent;
    copyCurlBtn.textContent = 'COPIED!';
    setTimeout(() => { copyCurlBtn.textContent = orig; copyCurlBtn.classList.remove('flash'); }, 1400);
  });
});

// ── Settings panel ────────────────────────────────────────────

const PROVIDERS = [
  // Frontier
  { id: 'gemini',      name: 'Gemini',              group: 'Frontier',    placeholder: 'AIza...',        defaultModel: 'gemini-2.0-flash',                              note: 'generativelanguage.googleapis.com' },
  { id: 'claude',      name: 'Claude',              group: 'Frontier',    placeholder: 'sk-ant-api03-…', defaultModel: 'claude-haiku-4-5-20251001',                     note: 'api.anthropic.com' },
  { id: 'openai',      name: 'OpenAI (GPT)',         group: 'Frontier',    placeholder: 'sk-…',           defaultModel: 'gpt-4o-mini',                                   note: 'api.openai.com' },
  { id: 'grok',        name: 'xAI (Grok)',           group: 'Frontier',    placeholder: 'xai-…',          defaultModel: 'grok-3-mini',                                   note: 'api.x.ai' },
  // Fast / free inference
  { id: 'groq',        name: 'Groq',                group: 'Inference',   placeholder: 'gsk_…',          defaultModel: 'llama-3.1-8b-instant',                          note: 'api.groq.com' },
  { id: 'cerebras',    name: 'Cerebras',            group: 'Inference',   placeholder: 'csk-…',          defaultModel: 'llama3.1-8b',                                   note: 'api.cerebras.ai' },
  { id: 'sambanova',   name: 'SambaNova',           group: 'Inference',   placeholder: 'key…',           defaultModel: 'Meta-Llama-3.2-3B-Instruct',                    note: 'api.sambanova.ai' },
  { id: 'siliconflow', name: 'SiliconFlow',         group: 'Inference',   placeholder: 'sk-…',           defaultModel: 'Qwen/Qwen2.5-7B-Instruct',                      note: 'api.siliconflow.cn' },
  { id: 'together',    name: 'Together AI',         group: 'Inference',   placeholder: 'key…',           defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',   note: 'api.together.xyz' },
  { id: 'fireworks',   name: 'Fireworks AI',        group: 'Inference',   placeholder: 'fw_…',           defaultModel: 'accounts/fireworks/models/llama-v3p1-8b-instruct', note: 'api.fireworks.ai' },
  { id: 'deepinfra',   name: 'DeepInfra',           group: 'Inference',   placeholder: 'key…',           defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct',         note: 'api.deepinfra.com' },
  { id: 'novita',      name: 'Novita AI',           group: 'Inference',   placeholder: 'key…',           defaultModel: 'meta-llama/llama-3.1-8b-instruct',              note: 'api.novita.ai' },
  { id: 'hyperbolic',  name: 'Hyperbolic',          group: 'Inference',   placeholder: 'key…',           defaultModel: 'meta-llama/Llama-3.2-3B-Instruct',              note: 'api.hyperbolic.xyz' },
  { id: 'lepton',      name: 'Lepton AI',           group: 'Inference',   placeholder: 'key…',           defaultModel: 'llama3-1-8b',                                   note: 'api.lepton.ai' },
  { id: 'nvidia',      name: 'NVIDIA NIM',          group: 'Inference',   placeholder: 'nvapi-…',        defaultModel: 'meta/llama-3.1-8b-instruct',                    note: 'integrate.api.nvidia.com' },
  // LLM providers
  { id: 'mistral',     name: 'Mistral AI',          group: 'LLM',         placeholder: 'key…',           defaultModel: 'mistral-small-latest',                          note: 'api.mistral.ai' },
  { id: 'deepseek',    name: 'DeepSeek',            group: 'LLM',         placeholder: 'sk-…',           defaultModel: 'deepseek-chat',                                 note: 'api.deepseek.com' },
  { id: 'perplexity',  name: 'Perplexity (Sonar)',  group: 'LLM',         placeholder: 'pplx-…',         defaultModel: 'sonar',                                         note: 'api.perplexity.ai' },
  { id: 'cohere',      name: 'Cohere',              group: 'LLM',         placeholder: 'key…',           defaultModel: 'command-r',                                     note: 'api.cohere.com' },
  { id: 'ai21',        name: 'AI21 Labs',           group: 'LLM',         placeholder: 'key…',           defaultModel: 'jamba-mini-1.6',                                note: 'api.ai21.com' },
  { id: 'reka',        name: 'Reka AI',             group: 'LLM',         placeholder: 'key…',           defaultModel: 'reka-flash-3',                                  note: 'api.reka.ai' },
  { id: 'inflection',  name: 'Inflection AI',       group: 'LLM',         placeholder: 'key…',           defaultModel: 'inflection_3_pi',                               note: 'api.inflection.ai' },
  // Chinese LLMs
  { id: 'qwen',        name: 'Qwen (Alibaba)',       group: 'Chinese',     placeholder: 'sk-…',           defaultModel: 'qwen-turbo',                                    note: 'dashscope-intl.aliyuncs.com' },
  { id: 'moonshot',    name: 'Moonshot (Kimi)',      group: 'Chinese',     placeholder: 'sk-…',           defaultModel: 'moonshot-v1-8k',                                note: 'api.moonshot.cn' },
  { id: 'zhipu',       name: 'Zhipu (GLM)',          group: 'Chinese',     placeholder: 'key…',           defaultModel: 'glm-4-flash',                                   note: 'open.bigmodel.cn' },
  { id: 'minimax',     name: 'MiniMax',             group: 'Chinese',     placeholder: 'key…',           defaultModel: 'MiniMax-Text-01',                               note: 'api.minimax.chat' },
  { id: 'stepfun',     name: 'StepFun',             group: 'Chinese',     placeholder: 'key…',           defaultModel: 'step-1-mini',                                   note: 'api.stepfun.com' },
  { id: 'hunyuan',     name: 'Tencent Hunyuan',     group: 'Chinese',     placeholder: 'key…',           defaultModel: 'hunyuan-lite',                                  note: 'api.hunyuan.cloud.tencent.com' },
  { id: 'yi',          name: '01.AI (Yi)',           group: 'Chinese',     placeholder: 'key…',           defaultModel: 'yi-lightning',                                  note: 'api.lingyiwanwu.com' },
  // Gateways (aggregators)
  { id: 'openrouter',  name: 'OpenRouter',          group: 'Gateways',    placeholder: 'sk-or-v1-…',     defaultModel: 'meta-llama/llama-3.2-3b-instruct:free',          note: 'openrouter.ai' },
  { id: 'aimlapi',     name: 'AIMLAPI',             group: 'Gateways',    placeholder: 'key…',           defaultModel: 'meta-llama/Llama-3.2-3B-Instruct-Turbo',        note: 'api.aimlapi.com' },
  // Cloud / custom URL
  { id: 'azure',       name: 'Azure OpenAI',        group: 'Cloud',       placeholder: 'key…',           defaultModel: 'gpt-4o-mini',  customUrl: true, urlPlaceholder: 'https://{resource}.openai.azure.com/openai/deployments/{deploy}/chat/completions?api-version=2024-12-01-preview', note: 'azure.com' },
  { id: 'custom',      name: 'Custom (OAI-compat)', group: 'Cloud',       placeholder: 'key…',           defaultModel: '',             customUrl: true, urlPlaceholder: 'https://your-host/v1', note: 'custom endpoint' },
];

const PROVIDER_MAP = Object.fromEntries(PROVIDERS.map(p => [p.id, p]));

// Build grouped <select> from PROVIDERS array
(function buildProviderSelect() {
  const sel = $('providerSelect');
  const groups = {};
  PROVIDERS.forEach(p => { (groups[p.group] = groups[p.group] || []).push(p); });
  Object.entries(groups).forEach(([grp, list]) => {
    const og = document.createElement('optgroup');
    og.label = `── ${grp} ──`;
    list.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
})();

const settingsBtn   = $('settingsBtn');
const settingsPanel = $('settingsPanel');
const keyInput      = $('keyInput');
const keySaveBtn    = $('keySaveBtn');
const keyDeleteBtn  = $('keyDeleteBtn');
const keyStatus     = $('keyStatus');

let currentProvider = 'gemini';

function applySettings(settings) {
  const pid = settings.provider || 'gemini';
  currentProvider = pid;
  const p = PROVIDER_MAP[pid] || PROVIDER_MAP.custom;

  $('providerSelect').value = pid;
  keyInput.placeholder = p.placeholder || 'key…';
  $('keyNote').textContent = `stored in chrome.storage.local · sent only to ${p.note}`;

  // Model input
  $('modelInput').value = (settings.models || {})[pid] || p.defaultModel || '';

  // URL row (Azure / custom)
  if (p.customUrl) {
    $('urlRow').classList.remove('hidden');
    $('urlInput').value = (settings.urls || {})[pid] || '';
    $('urlInput').placeholder = p.urlPlaceholder || '';
  } else {
    $('urlRow').classList.add('hidden');
  }

  // Key status
  const isSet = (settings.keysSet || []).includes(pid);
  keyStatus.textContent = isSet ? 'key set ✓' : 'no key set';
  keyStatus.classList.toggle('key-set', isSet);
  keyDeleteBtn.classList.toggle('hidden', !isSet);
  aiBtn.classList.toggle('ai-ready', isSet);
}

function loadSettings(cb) {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res) => {
    if (res) applySettings(res);
    if (cb) cb(res);
  });
}

settingsBtn.addEventListener('click', () => {
  const nowOpen = settingsPanel.classList.toggle('hidden');
  settingsBtn.classList.toggle('active', !nowOpen);
  if (!nowOpen) loadSettings();
});

$('providerSelect').addEventListener('change', (e) => {
  const p = e.target.value;
  chrome.runtime.sendMessage({ type: 'SET_PROVIDER', provider: p }, () => loadSettings());
});

keySaveBtn.addEventListener('click', () => {
  const key = keyInput.value.trim();
  if (!key) return;
  chrome.runtime.sendMessage({ type: 'SAVE_KEY', provider: currentProvider, key }, () => {
    keyInput.value = '';
    loadSettings();
    keySaveBtn.textContent = 'SAVED!';
    setTimeout(() => { keySaveBtn.textContent = 'SAVE'; }, 1400);
  });
});

keyDeleteBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DELETE_KEY', provider: currentProvider }, () => loadSettings());
});

$('modelSaveBtn').addEventListener('click', () => {
  const model = $('modelInput').value.trim();
  chrome.runtime.sendMessage({ type: 'SAVE_MODEL', provider: currentProvider, model }, () => {
    $('modelSaveBtn').textContent = '✓';
    setTimeout(() => { $('modelSaveBtn').textContent = '↵'; }, 1200);
  });
});

$('urlSaveBtn').addEventListener('click', () => {
  const url = $('urlInput').value.trim();
  chrome.runtime.sendMessage({ type: 'SAVE_URL', provider: currentProvider, url }, () => {
    $('urlSaveBtn').textContent = '✓';
    setTimeout(() => { $('urlSaveBtn').textContent = '↵'; }, 1200);
  });
});

// Theme
(function initTheme() {
  chrome.storage.local.get('theme', (d) => {
    const t = d.theme || 'pink';
    document.body.dataset.theme = t;
    document.querySelectorAll('.theme-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.t === t);
    });
  });
})();

document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.t;
    document.body.dataset.theme = t;
    chrome.storage.local.set({ theme: t });
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});

// Load on popup open — restore cached scan if available
loadSettings();

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;
  chrome.runtime.sendMessage({ type: 'GET_SCAN_CACHE', tabId: tab.id }, (res) => {
    if (!res || !res.data) return;
    const c = res.data;
    allData = c.allData;
    currentRootDomain  = c.rootDomain  || '';
    currentTabHostname = c.tabHostname || '';
    if (hostOnly && currentRootDomain) {
      hostBtn.textContent = `HOST: ${currentRootDomain}`;
      hostBtn.title = `Show only ${currentRootDomain} & subdomains`;
    }
    updateCounts();
    tabsEl.classList.remove('hidden');
    toolbarEl.classList.remove('hidden');
    showTab('all');
    const shown = applyHostFilter(allData.all).length;
    const domainInfo = (hostOnly && currentRootDomain) ? ` — ${shown} from ${currentRootDomain}` : '';
    const secretsInfo = allData.secrets?.length ? ` · ${allData.secrets.length} leak(s)` : '';
    setStatus(`found ${allData.all.length} total${domainInfo}${secretsInfo} (cached)`);
  });
});

// ── AI analysis view ──────────────────────────────────────────

// Rough token estimator (~4 chars per token)
function roughTokens(s) { return Math.ceil((s || '').length / 4); }

// Build data block that fits within a token budget.
// Spends half on endpoints, half on secrets; stops adding when budget hit.
function budgetData(data, tokenBudget) {
  const epBudget  = Math.floor(tokenBudget * 0.45);
  const secBudget = Math.floor(tokenBudget * 0.55);

  const epLines = [];
  let epUsed = 0;
  for (const e of (data.all || []).slice(0, 40)) {
    const line = fmtEp(e, currentRootDomain);
    const t = roughTokens(line);
    if (epUsed + t > epBudget) break;
    epLines.push(line); epUsed += t;
  }

  const secLines = [];
  let secUsed = 0;
  for (const s of (data.secrets || [])) {
    const line = `- [${s.type}] value: "${s.value}" | ctx: ${(s.context || '').slice(0, 150)}`;
    const t = roughTokens(line);
    if (secUsed + t > secBudget) break;
    secLines.push(line); secUsed += t;
  }

  return {
    eps:      epLines.join('\n')  || 'none',
    sec:      secLines.join('\n') || 'none',
    epShown:  epLines.length,
    epTotal:  (data.all     || []).length,
    secShown: secLines.length,
    secTotal: (data.secrets || []).length,
  };
}

// Tab-aware data selectors
// Endpoint-focused presets: use current tab's list; fallback to ALL when on LEAK tab
function activeEndpoints(data, tab) {
  return tab === 'secrets' ? (data.all || []) : (data[tab] || data.all || []);
}
// Mixed presets (full/custom): strictly respect tab — LEAK tab = only secrets, no endpoints
function getActiveData(data, tab) {
  return {
    endpoints: tab === 'secrets' ? [] : (data[tab] || data.all || []),
    secrets:   (tab === 'secrets' || tab === 'all') ? (data.secrets || []) : [],
  };
}

// Helper: shorten URL to path (save tokens)
function epToPath(url, rootDomain) {
  try {
    const u = new URL(url);
    const sameHost = !rootDomain || u.hostname === rootDomain || u.hostname.endsWith('.' + rootDomain);
    const qs = u.search.length > 1 ? u.search.slice(0, 30) : '';
    return sameHost ? (u.pathname + qs) : (u.host + u.pathname).slice(0, 60);
  } catch { return url.slice(0, 60); }
}

function fmtEp(e, rootDomain) {
  return `${e.method} ${epToPath(e.url, rootDomain)}${e.status ? ` [${e.status}]` : ''}`;
}

function filterEps(endpoints, pattern, rootDomain, limit) {
  return endpoints.filter(e => pattern.test(e.url)).slice(0, limit)
    .map(e => fmtEp(e, rootDomain)).join('\n');
}

// Preset definitions — each builds an optimized, focused prompt
const AI_PRESETS = [
  {
    id: 'leaks',
    label: 'Leak severity — which are actually dangerous?',
    build(data, target) {
      const all = data.secrets || [];
      if (!all.length) return `Target: ${target}\n\nNo leaked credentials found.`;
      const tail = `\n\nFor each: rate CRITICAL/HIGH/MEDIUM/LOW/FALSE-POSITIVE and what attacker can do. Use the context to understand what each credential is for. Skip false positives. Be concise.`;
      const budget = 5200 - roughTokens(`Target: ${target}\nLeaked credentials (${all.length}):`) - roughTokens(tail);
      const lines = [];
      let used = 0;
      for (let i = 0; i < all.length; i++) {
        const x = all[i];
        const line = `${i + 1}. [${x.type}] value: "${x.value}"\n   context: ${(x.context || '').slice(0, 200)}`;
        const t = roughTokens(line);
        if (used + t > budget) break;
        lines.push(line); used += t;
      }
      const note = lines.length < all.length ? ` (${lines.length}/${all.length})` : '';
      return `Target: ${target}\nLeaked credentials (${all.length}${note}):\n${lines.join('\n')}${tail}`;
    },
  },
  {
    id: 'priority',
    label: 'Top targets — ranked by impact',
    build(data, target, tab) {
      const API_PAT = /\/(api|v\d|graphql|rest|auth|login|user|account|admin|pay|upload|search|file|order|cart|webhook|export|report|token|oauth|profile|config|internal|manage|dashboard|transfer|withdraw|invite|impersonate)\b/i;
      const pool = activeEndpoints(data, tab);
      const ranked = [
        ...pool.filter(e => API_PAT.test(e.url)),
        ...pool.filter(e => !API_PAT.test(e.url)),
      ].slice(0, 40).map(e => fmtEp(e, currentRootDomain)).join('\n');
      return `Target: ${target} [${tabLabel(tab)}, ${pool.length} endpoints]
${ranked}

You are a bug bounty hunter. Identify the 8 highest-value targets.
For each write exactly:
[SEVERITY] METHOD /path → vuln type → one-line test step
Severity: Critical/High/Medium. Focus: IDOR, unauth access, mass assignment, SSRF, injection. Skip static assets.`;
    },
  },
  {
    id: 'auth',
    label: 'Auth & access control flaws',
    build(data, target, tab) {
      const PAT = /\/(auth|login|logout|signin|signup|token|oauth|sso|session|password|forgot|reset|verify|2fa|mfa|register|account|me|user|profile|admin|manage|dashboard|permission|role|grant|revoke)\b/i;
      const pool = activeEndpoints(data, tab);
      const matched = filterEps(pool, PAT, currentRootDomain, 35);
      const allEps  = matched || pool.slice(0, 20).map(e => fmtEp(e, currentRootDomain)).join('\n');
      return `Target: ${target} — auth surface [${tabLabel(tab)}]:
${allEps}

For each endpoint, check:
1. Unauthenticated access — remove Authorization/Cookie header entirely
2. JWT — try alg:none, expired token, role field manipulation (user→admin)
3. OAuth — redirect_uri whitelist bypass, missing state param, token in URL
4. Password reset — host header injection, predictable token, response body manipulation
5. Privilege escalation — call admin endpoint as regular user
6. 2FA — code reuse, race condition bypass, backup code brute force
Output: endpoint → specific attack → severity (Critical/High/Med).`;
    },
  },
  {
    id: 'sensitive',
    label: 'Exposed sensitive / admin paths',
    build(data, target, tab) {
      const PAT = /\/(admin|dashboard|manage|control|config|settings?|debug|swagger|api-docs|openapi|redoc|\.env|backup|dump|export|logs?|metrics|health|actuator|phpinfo|\.git|internal|private|secret|console|devtools?|trace|monitor|status|panel|portal)\b/i;
      const eps = filterEps(activeEndpoints(data, tab), PAT, currentRootDomain, 35);
      if (!eps) return `Target: ${target}\n\nNo sensitive/admin paths found in ${tabLabel(tab)}.`;
      return `Target: ${target} — sensitive paths [${tabLabel(tab)}]:
${eps}

Triage each path:
- [CRITICAL] Admin/console accessible without auth (200 status)
- [HIGH] API docs (swagger/openapi) exposed — list dangerous endpoints documented
- [HIGH] Debug/trace endpoints — stack traces, env vars, internal IPs leaked
- [MEDIUM] Health/metrics — internal service info exposed
- [LOW] Exists but properly auth-gated
For top 3 critical/high findings: what exactly can an attacker do?`;
    },
  },
  {
    id: 'idor',
    label: 'IDOR & parameter tampering',
    build(data, target, tab) {
      const PAT = /\/(\d{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9_-]{6,})\b(?=\/|$|\?)/i;
      const pool = activeEndpoints(data, tab);
      const matched = filterEps(pool, PAT, currentRootDomain, 35);
      const allEps  = matched || pool.slice(0, 20).map(e => fmtEp(e, currentRootDomain)).join('\n');
      return `Target: ${target} — object references [${tabLabel(tab)}]:
${allEps}

IDOR and privilege escalation analysis:
1. Sequential numeric IDs → increment/decrement, access another user's resource
2. UUIDs → are they truly random or derived from email/timestamp?
3. Horizontal: /users/123/orders → change 123 to another user's ID
4. Vertical: /user/profile → try /admin/profile or add ?role=admin
5. Mass assignment: POST/PUT bodies — add "role":"admin", "is_admin":true, "balance":9999
6. Hidden param injection: append ?user_id=X to any endpoint
For top 5: exact path, payload, what data/action is exposed.`;
    },
  },
  {
    id: 'cors',
    label: 'CORS & security headers',
    build(data, target, tab) {
      const pool = activeEndpoints(data, tab).filter(e => e.resHeaders);
      if (!pool.length) {
        const allEps = activeEndpoints(data, tab).slice(0, 25).map(e => fmtEp(e, currentRootDomain)).join('\n');
        return `Target: ${target} — no headers captured yet [${tabLabel(tab)}]
${allEps}

No response headers captured (reload page after clicking LIST to capture them).
Based on endpoint patterns, predict likely misconfigs:
- /api/* endpoints: CORS misconfiguration likely?
- Login/auth: CSRF protection present?
- File upload: content-type validation?
- Admin panels: X-Frame-Options missing (clickjacking)?
Which 3 endpoints to prioritize for manual header inspection?`;
      }
      const lines = pool.slice(0, 25).map(e => {
        const h = e.resHeaders;
        const cors  = h['access-control-allow-origin'] || '-';
        const creds = h['access-control-allow-credentials'] || '-';
        const csp   = h['content-security-policy'] ? 'CSP:✓' : 'CSP:✗';
        const hsts  = h['strict-transport-security'] ? 'HSTS:✓' : 'HSTS:✗';
        const xfo   = h['x-frame-options'] ? `XFO:${h['x-frame-options']}` : 'XFO:✗';
        const cookie = h['set-cookie'] ? 'Cookie:set' : '';
        return `${fmtEp(e, currentRootDomain)} | CORS:${cors} creds:${creds} ${csp} ${hsts} ${xfo} ${cookie}`.trim();
      }).join('\n');
      return `Target: ${target} — security headers [${tabLabel(tab)}]:
${lines}

Find exploitable misconfigs (severity order):
1. [CRITICAL] CORS * + credentials:true — any endpoint?
2. [HIGH] CORS allows specific origin that can be spoofed or is a subdomain?
3. [HIGH] CSP missing on pages that render user input → XSS amplified
4. [MEDIUM] X-Frame-Options missing on login/account pages → clickjacking
5. [MEDIUM] HSTS missing → SSL stripping on sensitive paths
6. [INFO] Cookies without Secure/HttpOnly/SameSite flags
Write PoC for the worst finding.`;
    },
  },
  {
    id: 'full',
    label: 'Attack surface overview',
    build(data, target, tab) {
      const { endpoints, secrets } = getActiveData(data, tab);
      const eps = endpoints.slice(0, 40).map(e => fmtEp(e, currentRootDomain)).join('\n');
      const sec = secrets.slice(0, 10).map(s => `- [${s.type}] ${s.value.slice(0, 30)}`).join('\n') || 'none';
      const parts = [];
      if (endpoints.length) parts.push(`${endpoints.length} endpoints`);
      if (secrets.length)   parts.push(`${secrets.length} leaks`);
      return `Target: ${target} [${tabLabel(tab)}: ${parts.join(', ')}]

Endpoints:
${eps || 'none'}

Leaked credentials:
${sec}

Structured attack surface report:
## Quick Wins (exploitable now, <30 min each)
## High-Value Targets (need more testing)
## Credential Risk (leaked keys/tokens — what can attacker do with each?)
## Attack Chains (combine findings for higher impact)
Be specific: path + technique + impact. Skip noise.`;
    },
  },
  {
    id: 'custom',
    label: '✏  Custom prompt',
    build(data, target, tab) {
      const userText = ($('customPromptInput').value || '').trim();
      if (!userText) return null;
      const { endpoints, secrets } = getActiveData(data, tab);
      const userTokens = roughTokens(userText);
      const { eps, sec, epShown, epTotal, secShown, secTotal } =
        budgetData({ all: endpoints, secrets }, Math.max(2000, 7000 - userTokens));
      const epNote  = epTotal  ? (epShown  < epTotal  ? ` (${epShown}/${epTotal})` : ` (${epTotal})`) : '';
      const secNote = secTotal ? (secShown < secTotal ? ` (${secShown}/${secTotal})` : ` (${secTotal})`) : '';
      const parts = [];
      if (epTotal)  parts.push(`endpoints${epNote}`);
      if (secTotal) parts.push(`leaks${secNote}`);
      return `${userText}\n\n---\nScan data — ${target} [${tabLabel(tab)}${parts.length ? ': ' + parts.join(', ') : ''}]:\n${epTotal ? `Endpoints:\n${eps}\n` : ''}${secTotal ? `Leaked credentials:\n${sec}` : ''}`;
    },
  },
];

// Build preset <select> options
(function buildPresetSelect() {
  const sel = $('presetSelect');
  AI_PRESETS.forEach(p => {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.label;
    sel.appendChild(o);
  });
})();

$('presetSelect').addEventListener('change', (e) => {
  $('customPromptInput').classList.toggle('hidden', e.target.value !== 'custom');
  updateDataNote();
});

const TAB_LABELS = { all: 'ALL', network: 'NET', dynamic: 'DYN', static: 'SRC', secrets: 'LEAK' };
function tabLabel(tab) { return TAB_LABELS[tab] || tab.toUpperCase(); }

function updateDataNote() {
  const tab = currentTab;
  const presetId = $('presetSelect').value;
  let eps = 0, sec = 0;
  if (presetId === 'leaks') {
    sec = (allData.secrets || []).length;
  } else if (presetId === 'full' || presetId === 'custom') {
    const d = getActiveData(allData, tab);
    eps = d.endpoints.length; sec = d.secrets.length;
  } else {
    eps = activeEndpoints(allData, tab).length;
  }
  const parts = [];
  if (eps) parts.push(`${eps} ep`);
  if (sec) parts.push(`${sec} leaks`);
  $('aiDataNote').textContent = `${tabLabel(tab)}${parts.length ? ' · ' + parts.join(' · ') : ''}`;
}

function renderMarkdown(text) {
  let html = escHtml(text);
  html = html.replace(/^#{1,3} (.+)$/gm, '<div class="ai-h2">$1</div>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/^[-•*] (.+)$/gm, '<div class="ai-li">$1</div>');
  html = html.replace(/^\d+\. (.+)$/gm, '<div class="ai-li">$1</div>');
  html = html.replace(/\n{2,}/g, '<br>');
  return html;
}

function showAiView() {
  mainView.classList.add('hidden');
  detailView.classList.add('hidden');
  aiView.classList.remove('hidden');
  updateDataNote();
}

$('aiBackBtn').addEventListener('click', () => {
  aiView.classList.add('hidden');
  mainView.classList.remove('hidden');
});

function runAiPreset() {
  const presetId = $('presetSelect').value;
  const preset = AI_PRESETS.find(p => p.id === presetId) || AI_PRESETS[0];
  const target = currentRootDomain || currentTabHostname || 'unknown';
  const prompt = preset.build(allData, target, currentTab);
  if (!prompt) {
    $('aiResult').innerHTML = '<span style="color:#ff5577">type your prompt first</span>';
    return;
  }

  $('aiLoading').classList.remove('hidden');
  $('aiResult').innerHTML = '';
  $('aiRunBtn').disabled = true;

  chrome.runtime.sendMessage({ type: 'AI_ANALYZE', prompt }, (res) => {
    $('aiLoading').classList.add('hidden');
    $('aiRunBtn').disabled = false;
    if (res && res.ok) {
      $('aiResult').innerHTML = renderMarkdown(res.result);
    } else {
      $('aiResult').innerHTML = `<span style="color:#ff5577">error: ${escHtml((res && res.error) || 'unknown')}</span>`;
    }
  });
}

$('aiRunBtn').addEventListener('click', runAiPreset);

aiBtn.addEventListener('click', async () => {
  const hasKey = await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, res => {
      const p = res?.provider || 'gemini';
      r(res && (res.keysSet || []).includes(p));
    })
  );
  if (!hasKey) {
    settingsPanel.classList.remove('hidden');
    settingsBtn.classList.add('active');
    loadSettings();
    return;
  }
  if (!allData.all.length) return;
  showAiView();
});
