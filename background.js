const tabData = {};
const _pending = {}; // requestId -> { tabId, url }

const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|ico|css|woff2?|ttf|eot|svg|mp4|webm|mp3|wav|pdf|map|txt)(\?.*)?$/i;
const SKIP_HOSTS = /google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|mixpanel|segment\.com|clarity\.ms|bat\.bing/i;

// Response headers worth capturing for recon
const RES_HDR_KEEP = new Set([
  'server', 'x-powered-by', 'x-aspnet-version', 'x-runtime', 'x-generator',
  'access-control-allow-origin', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-allow-credentials',
  'x-frame-options', 'content-security-policy', 'strict-transport-security',
  'x-content-type-options', 'x-xss-protection',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-rate-limit',
  'set-cookie', 'content-type',
  'x-version', 'api-version', 'x-api-version',
  'cf-ray', 'x-amzn-requestid', 'x-request-id',
]);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { tabId, url, method, type, requestId } = details;
    if (tabId < 0) return;
    if (SKIP_EXTENSIONS.test(url)) return;
    if (SKIP_HOSTS.test(url)) return;

    _pending[requestId] = { tabId, url };

    if (!tabData[tabId]) tabData[tabId] = [];
    const exists = tabData[tabId].some(r => r.url === url && r.method === (method || 'GET'));
    if (!exists) {
      tabData[tabId].push({
        url, method: method || 'GET', type, ts: Date.now(),
        status: null, resHeaders: null,
      });
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { requestId, statusCode, responseHeaders } = details;
    const meta = _pending[requestId];
    if (!meta) return;
    delete _pending[requestId];

    const { tabId, url } = meta;
    if (!tabData[tabId]) return;
    const entry = tabData[tabId].find(r => r.url === url);
    if (!entry) return;

    entry.status = statusCode;
    const rh = {};
    for (const h of (responseHeaders || [])) {
      const name = h.name.toLowerCase();
      if (!RES_HDR_KEEP.has(name)) continue;
      if (name === 'set-cookie') {
        if (!rh['set-cookie']) rh['set-cookie'] = [];
        rh['set-cookie'].push(h.value);
      } else {
        rh[name] = h.value;
      }
    }
    if (Object.keys(rh).length) entry.resHeaders = rh;
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') tabData[tabId] = [];
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabData[tabId];
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_NETWORK') {
    sendResponse({ data: tabData[msg.tabId] || [] });
    return true;
  }
  if (msg.type === 'CLEAR') {
    tabData[msg.tabId] = [];
    sendResponse({ ok: true });
    return true;
  }
  return true;
});
