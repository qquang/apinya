let allData = { all: [], network: [], dynamic: [], static: [] };
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
const copyAllBtn  = $('copyAllBtn');
const hostBtn     = $('hostBtn');
const mainView    = $('mainView');
const detailView  = $('detailView');
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
  render(allData[tab] || []);
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
      src: 'N'
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
      all:     allItems,
      network: mergedNetwork,
      dynamic: mergedDynamic,
      static:  mergedStatic
    };

    updateCounts();
    tabsEl.classList.remove('hidden');
    toolbarEl.classList.remove('hidden');
    showTab('all');

    const shown = applyHostFilter(allItems).length;
    const domainInfo = (hostOnly && currentRootDomain) ? ` — ${shown} from ${currentRootDomain}` : '';
    setStatus(`found ${allItems.length} total${domainInfo} — click any for Burp request`);
  } catch (err) {
    setStatus(`error: ${err.message}`, true);
  } finally {
    listBtn.disabled = false;
    listBtn.classList.remove('scanning');
  }
});

clearBtn.addEventListener('click', () => {
  allData = { all: [], network: [], dynamic: [], static: [] };
  updateCounts();
  listEl.innerHTML = '';
  filterInput.value = '';
  tabsEl.classList.add('hidden');
  toolbarEl.classList.add('hidden');
  resultsEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
  statusEl.classList.add('hidden');
  statusEl.textContent = '';

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) chrome.runtime.sendMessage({ type: 'CLEAR', tabId: tab.id });
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

  // Show hint about body source
  if (capturedBody) {
    fieldHint.textContent = `body: captured from actual request (${Object.keys(capturedBody).length} fields)`;
    fieldHint.classList.remove('hidden');
  } else if (bodyFields.length > 0) {
    fieldHint.textContent = `body: inferred from JS source — ${bodyFields.join(', ')}`;
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
  lines.push(`Accept-Language: vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7`);
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
